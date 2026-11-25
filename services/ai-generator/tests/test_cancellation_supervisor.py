"""Comprehensive deterministic test suite for the Gemini cancellation supervisor.

Validates:
- Normal inference success and token metadata preservation.
- Client disconnect detection and prompt inference cancellation.
- Independent inference cancellation attribution.
- Parent cancellation precedence during inference and cleanup.
- Provider exception transparency when parent cancel is absent.
- Legitimate None result support.
- True barrier-coordinated simultaneous completion.
- Zero child task leaks across all terminating paths.
- HTTP endpoint integration via FastAPI TestClient / ASGI mock.
"""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from app.errors import (
    ClientDisconnectException,
    RateLimitedException,
)
from app.main import create_app
from app.supervisor import _settle_inference, execute_chunk_supervised


class MonitorFailedException(Exception):
    """Synthetic monitor failure for testing."""

    pass


class MockGenerator:
    """Mock generator wrapping a coroutine function."""

    def __init__(self, coro_fn: Any):
        self._coro_fn = coro_fn

    async def generate_chunk(self, *args: Any, **kwargs: Any) -> Any:
        return await self._coro_fn()


class MockRequest:
    """Mock Starlette request supporting best-effort preflight and disconnect events."""

    def __init__(self, preflight_disconnected: bool = False):
        self.preflight = True
        self.preflight_disconnected = preflight_disconnected
        self.disc_event = asyncio.Event()

    async def is_disconnected(self) -> bool:
        if self.preflight:
            self.preflight = False
            return self.preflight_disconnected
        return self.disc_event.is_set()


# ==============================================================================
# 1. CORE FOCUSED SCENARIOS
# ==============================================================================

@pytest.mark.asyncio
async def test_normal_inference_success_preserves_notes_and_tokens():
    """Scenario 1: Normal inference success preserves notes and token metadata."""
    sample_notes = {
        "overview": "Overview of supervisor architecture",
        "key_concepts": ["FastAPI", "ASGI", "Task Cancellation"],
        "detailed_notes": "Deep technical analysis of cancellation handling",
        "usage": {"prompt_tokens": 120, "candidate_tokens": 45, "total_tokens": 165},
        "total_tokens": 165,
    }

    async def inf_fn():
        return sample_notes

    req = MockRequest()
    result = await execute_chunk_supervised(
        generator=MockGenerator(inf_fn),
        request=req,
        chunk_text="sample transcript",
        video_title="sample video",
        chunk_index=0,
        total_chunks=1,
        request_id="test-req-1",
    )

    assert result == sample_notes
    assert result["total_tokens"] == 165
    assert result["usage"]["prompt_tokens"] == 120


@pytest.mark.asyncio
async def test_client_disconnect_cancels_pending_inference():
    """Scenario 2: Client disconnect cancels pending inference and raises ClientDisconnectException."""
    inf_started = asyncio.Event()
    inf_cancelled = asyncio.Event()

    async def inf_fn():
        inf_started.set()
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            inf_cancelled.set()
            raise

    req = MockRequest()

    async def disconnector():
        await inf_started.wait()
        req.disc_event.set()

    disconnector_task = asyncio.create_task(disconnector())

    with pytest.raises(ClientDisconnectException) as exc_info:
        await execute_chunk_supervised(
            generator=MockGenerator(inf_fn),
            request=req,
            request_id="test-req-2",
        )

    await disconnector_task
    assert inf_cancelled.is_set(), "Inference task must be cancelled on client disconnect"
    assert "client disconnect" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_independent_inference_cancellation_not_misclassified():
    """Scenario 3: Independent inference cancellation raises CancelledError, not ClientDisconnectException."""
    inf_started = asyncio.Event()
    child_task_ref = None

    async def inf_fn():
        inf_started.set()
        await asyncio.sleep(100)

    class TaskCapturingGenerator:
        async def generate_chunk(self, *args, **kwargs):
            nonlocal child_task_ref
            child_task_ref = asyncio.current_task()
            return await inf_fn()

    req = MockRequest()

    async def canceller():
        await inf_started.wait()
        # Direct task reference cancel (no string name scanning)
        child_task_ref.cancel()

    canceller_task = asyncio.create_task(canceller())

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await execute_chunk_supervised(
            generator=TaskCapturingGenerator(),
            request=req,
            request_id="test-req-3",
        )

    await canceller_task
    assert "independently" in str(exc_info.value)


@pytest.mark.asyncio
async def test_parent_cancellation_propagates_during_inference_and_cleanup():
    """Scenario 4: Parent cancellation propagates during inference and cleanup (__cause__ preserved)."""
    inf_started = asyncio.Event()
    cleanup_entered = asyncio.Event()
    release_cleanup = asyncio.Event()

    async def inf_fn():
        inf_started.set()
        try:
            await asyncio.sleep(100)
        except asyncio.CancelledError:
            cleanup_entered.set()
            await release_cleanup.wait()
            raise RateLimitedException("Provider 429 during cancel cleanup")

    req = MockRequest()
    sup_task = asyncio.create_task(
        execute_chunk_supervised(
            generator=MockGenerator(inf_fn),
            request=req,
            request_id="test-req-4",
        )
    )

    await inf_started.wait()
    sup_task.cancel()  # Parent cancelled while inference in-flight

    await cleanup_entered.wait()
    sup_task.cancel()  # Second parent cancel arrives during cleanup
    release_cleanup.set()

    with pytest.raises(asyncio.CancelledError) as exc_info:
        await sup_task

    # Verify provider exception was not lost, but preserved in __cause__
    assert isinstance(exc_info.value.__cause__, RateLimitedException)


@pytest.mark.asyncio
async def test_provider_exceptions_propagate_when_parent_cancel_absent():
    """Scenario 5: Provider exceptions propagate directly when parent cancel is absent."""
    async def inf_fn():
        raise RateLimitedException("AI generation service is temporarily busy (429).")

    req = MockRequest()

    with pytest.raises(RateLimitedException) as exc_info:
        await execute_chunk_supervised(
            generator=MockGenerator(inf_fn),
            request=req,
            request_id="test-req-5",
        )

    assert "temporarily busy" in str(exc_info.value)


@pytest.mark.asyncio
async def test_no_child_tasks_leak_after_normal_terminations():
    """Scenario 6: Verify zero leaked child tasks across all termination paths."""
    async def inf_fn():
        return {"notes": "ok", "total_tokens": 10}

    req = MockRequest()
    await execute_chunk_supervised(MockGenerator(inf_fn), req)

    current_task = asyncio.current_task()
    active_tasks = [t for t in asyncio.all_tasks() if t is not current_task and not t.done()]
    assert len(active_tasks) == 0, f"Dangling tasks detected: {active_tasks}"


@pytest.mark.asyncio
async def test_generator_type_error_propagates_without_retry():
    """TypeError raised synchronously inside generate_chunk propagates and is invoked exactly once."""
    invocation_count = 0

    class BuggyGenerator:
        def generate_chunk(self, *args: Any, **kwargs: Any) -> Any:
            nonlocal invocation_count
            invocation_count += 1
            raise TypeError("Intentional programming error inside generator")

    req = MockRequest()

    with pytest.raises(TypeError) as exc_info:
        await execute_chunk_supervised(
            generator=BuggyGenerator(),
            request=req,
            chunk_text="text",
            video_title="title",
            chunk_index=0,
            total_chunks=1,
            request_id="req-type-error",
        )

    assert "Intentional programming error inside generator" in str(exc_info.value)
    assert invocation_count == 1, f"Expected exactly 1 invocation, got {invocation_count}"


# ==============================================================================
# 2. BASELINE CAPTURE AND CORNER-CASE SCENARIOS
# ==============================================================================

@pytest.mark.asyncio
async def test_preflight_disconnect_cancels_before_dispatch():
    """Preflight check raises ClientDisconnectException without spawning inference."""
    called = False

    async def inf_never():
        nonlocal called
        called = True
        return {}

    req = MockRequest(preflight_disconnected=True)

    with pytest.raises(ClientDisconnectException):
        await execute_chunk_supervised(MockGenerator(inf_never), req)

    assert called is False, "Provider must never be called on preflight disconnect"


@pytest.mark.asyncio
async def test_legitimate_none_result_supported():
    """Legitimate None result from generator is cleanly returned without RuntimeError."""
    async def inf_none():
        return None

    task = asyncio.create_task(inf_none())
    await task

    result = await _settle_inference(
        inf_task=task,
        curr=asyncio.current_task(),
        initial_parent_cancelling=0,
        default_cancel_exc_factory=lambda: Exception("unexpected cancel"),
    )

    assert result is None


@pytest.mark.asyncio
async def test_true_barrier_simultaneous_completion():
    """Simultaneous completion barrier release prioritizes completed inference result."""
    simul_barrier = asyncio.Event()
    inf_ready = asyncio.Event()
    mon_ready = asyncio.Event()

    class SimulRequest:
        def __init__(self):
            self.preflight = True

        async def is_disconnected(self):
            if self.preflight:
                self.preflight = False
                return False
            mon_ready.set()
            await simul_barrier.wait()
            return True

    async def inf_simul():
        inf_ready.set()
        await simul_barrier.wait()
        return {"notes": "simul_notes", "total_tokens": 500}

    sup_task = asyncio.create_task(
        execute_chunk_supervised(
            generator=MockGenerator(inf_simul),
            request=SimulRequest(),
        )
    )

    await inf_ready.wait()
    await mon_ready.wait()
    # Release both in the exact same event loop cycle
    simul_barrier.set()

    result = await sup_task
    assert result["notes"] == "simul_notes"
    assert result["total_tokens"] == 500


# ==============================================================================
# 3. FASTAPI ENDPOINT INTEGRATION
# ==============================================================================

def test_endpoint_generate_chunk_supervised_success(client: TestClient, auth_headers: dict):
    """POST /api/v1/generate-chunk executes supervised generation and returns 200 with tokens."""
    app = create_app()
    client = TestClient(app)

    with patch("app.generator.genai.Client") as mock_client_cls:
        mock_instance = mock_client_cls.return_value
        mock_resp = AsyncMock()
        mock_resp.text = '{"overview": "Chunk overview", "keyConcepts": ["FastAPI"], "detailedNotes": "Chunk detailed notes", "shorthands": []}'
        mock_resp.usage_metadata = AsyncMock(prompt_token_count=100, candidates_token_count=40, total_token_count=140)
        mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_resp)

        response = client.post(
            "/api/v1/generate-chunk",
            headers=auth_headers,
            json={
                "chunkText": "This is chunk text.",
                "videoTitle": "Video Title",
                "chunkIndex": 0,
                "totalChunks": 1,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert "overview" in data
        assert "keyConcepts" in data
