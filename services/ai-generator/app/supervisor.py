"""Cancellation supervisor for Gemini chunk generation.

Supervises chunk generation concurrently with Starlette client disconnect polling.
Provides safe client-disconnect detection, Gemini task cancellation,
deterministic child task settlement, and parent cancellation precedence.
"""

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from app.errors import ClientDisconnectException

logger = logging.getLogger(__name__)


async def _settle_inference(
    inf_task: asyncio.Task,
    curr: asyncio.Task | None,
    initial_parent_cancelling: int,
    default_cancel_exc_factory: Callable[[], BaseException],
    context_exc: BaseException | None = None,
) -> Any:
    """Settle inf_task with strict parent-cancellation precedence.

    Guarantees:
    1. Parent cancellation check uses initial_parent_cancelling baseline.
       Detects cancellations occurring before or during settlement.
    2. Legitimate None result is fully supported via inf_completed flag.
    3. inf_cancel_requested records whether task was actively transitioned
       to cancelling (True) or was already done (False).
    4. Child CancelledError is never confused with parent CancelledError.
    5. Underlying provider exceptions are preserved in __cause__ if parent cancelled.
    """
    # Parent cancellation check before issuing cancel
    parent_already_cancelled = (curr.cancelling() > initial_parent_cancelling) if curr else False

    # Issue cancellation to child inference task
    inf_task.cancel()

    inf_result = None
    inf_exc: BaseException | None = None
    inf_completed = False

    try:
        inf_result = await inf_task
        inf_completed = True
    except BaseException as e:
        inf_exc = e

    current_parent_cancelling = curr.cancelling() if curr else 0
    parent_was_cancelled = parent_already_cancelled or (current_parent_cancelling > initial_parent_cancelling)

    if parent_was_cancelled:
        # Parent cancellation takes absolute precedence
        cancelled_err = asyncio.CancelledError("Parent supervisor was cancelled during inference settlement.")
        if inf_exc is not None and not isinstance(inf_exc, asyncio.CancelledError):
            cancelled_err.__cause__ = inf_exc
        elif context_exc is not None and not isinstance(context_exc, asyncio.CancelledError):
            cancelled_err.__cause__ = context_exc
        raise cancelled_err

    # Parent was NOT cancelled
    if inf_completed:
        # Inference completed successfully (supports legitimate None, string, or dict/ChunkGeneratedNotes)
        return inf_result

    if isinstance(inf_exc, asyncio.CancelledError):
        # Child cancelled cleanly in response to cancel signal
        raise default_cancel_exc_factory() from inf_exc

    if inf_exc is not None:
        # Child threw an application or provider error
        raise inf_exc

    raise RuntimeError("Unreachable inference settlement state")


async def execute_chunk_supervised(
    generator: Any,
    request: Any,
    chunk_text: str = "",
    video_title: str = "",
    chunk_index: int = 0,
    total_chunks: int = 1,
    request_id: str | None = None,
    poll_interval_s: float = 0.005,
) -> Any:
    """Supervise chunk generation concurrently with Starlette client disconnect polling.

    Guarantees:
    - Eager baseline capture at function entry before first await.
    - Centralized parent cancellation precedence across all paths.
    - Result preservation when inference completes without parent cancellation.
    - Zero swallowing of parent cancellation in cleanup.
    """
    curr = asyncio.current_task()
    initial_parent_cancelling = curr.cancelling() if curr else 0

    def is_parent_cancelled() -> bool:
        return (curr.cancelling() > initial_parent_cancelling) if curr else False

    # 1. Best-Effort Preflight Check (Accounting Boundary 1: Pre-Invocation)
    preflight_disc = await request.is_disconnected()
    if is_parent_cancelled():
        raise asyncio.CancelledError("Parent supervisor was cancelled during preflight.")
    if preflight_disc:
        raise ClientDisconnectException("Client disconnected prior to provider dispatch.")

    inf_task = None
    disc_task = None
    cleanup_cancellation_count = 0
    original_exception: BaseException | None = None

    async def _monitor_disconnect() -> None:
        while True:
            await asyncio.sleep(poll_interval_s)
            if await request.is_disconnected():
                return

    try:
        # Accounting Boundary 2: Provider Invocation Entered (provider_call_started)
        gen_coro = generator.generate_chunk(
            chunk_text=chunk_text,
            video_title=video_title,
            chunk_index=chunk_index,
            total_chunks=total_chunks,
            request_id=request_id,
        )

        inf_task = asyncio.create_task(
            gen_coro,
            name=f"gemini_inference_{request_id}_{chunk_index}",
        )
        disc_task = asyncio.create_task(
            _monitor_disconnect(),
            name=f"disconnect_monitor_{request_id}_{chunk_index}",
        )

        done, _ = await asyncio.wait([inf_task, disc_task], return_when=asyncio.FIRST_COMPLETED)

        # ----------------------------------------------------------------------
        # 2. State Inspection: Check inf_task first (Result Preservation)
        # ----------------------------------------------------------------------
        if inf_task in done:
            if not inf_task.cancelled():
                exc = inf_task.exception()
                if exc is None:
                    # Case A: Inference completed successfully
                    if is_parent_cancelled():
                        raise asyncio.CancelledError("Parent supervisor was cancelled before returning result.")
                    notes = inf_task.result()
                    return notes
                else:
                    # Case B: Inference threw an application/provider error
                    if is_parent_cancelled():
                        cancelled_err = asyncio.CancelledError("Parent supervisor was cancelled.")
                        cancelled_err.__cause__ = exc
                        raise cancelled_err
                    original_exception = exc
                    raise exc
            else:
                # Case C: inf_task was cancelled independently while in-flight
                if is_parent_cancelled():
                    raise asyncio.CancelledError("Parent supervisor was cancelled.")
                disconnect_observed = (
                    disc_task in done and not disc_task.cancelled() and disc_task.exception() is None
                )
                if not disconnect_observed:
                    cancelled_err = asyncio.CancelledError("Inference task was cancelled independently.")
                    original_exception = cancelled_err
                    raise cancelled_err
                else:
                    disc_exc = ClientDisconnectException("Inference cancelled and client disconnect observed.")
                    original_exception = disc_exc
                    raise disc_exc

        # ----------------------------------------------------------------------
        # 3. State Inspection: inf_task is pending, inspect disc_task
        # ----------------------------------------------------------------------
        if disc_task in done:
            if disc_task.cancelled():
                # Case D: Monitor was cancelled independently
                return await _settle_inference(
                    inf_task, curr, initial_parent_cancelling,
                    lambda: asyncio.CancelledError("Disconnect monitor was cancelled independently.")
                )

            disc_exc = disc_task.exception()
            if disc_exc is not None:
                # Case E: Monitor failed with an internal exception
                return await _settle_inference(
                    inf_task, curr, initial_parent_cancelling,
                    lambda: disc_exc,
                    context_exc=disc_exc,
                )

        # ----------------------------------------------------------------------
        # 4. Confirmed Disconnect Won FIRST_COMPLETED: Verified Clean Monitor Exit
        # ----------------------------------------------------------------------
        return await _settle_inference(
            inf_task, curr, initial_parent_cancelling,
            lambda: ClientDisconnectException("Inference task cancelled due to client disconnect.")
        )

    except BaseException as e:
        if original_exception is None:
            original_exception = e
        raise

    finally:
        # ----------------------------------------------------------------------
        # 5. Iterative Cleanup with Terminal Outcome Retrieval for ALL Children
        # ----------------------------------------------------------------------
        children = [t for t in (inf_task, disc_task) if t is not None]
        for t in children:
            if not t.done():
                t.cancel()

        while any(not c.done() for c in children):
            try:
                await asyncio.shield(
                    asyncio.gather(*[c for c in children if not c.done()], return_exceptions=True)
                )
            except asyncio.CancelledError:
                cleanup_cancellation_count += 1

        for c in children:
            if c.cancelled():
                pass
            else:
                c_exc = c.exception()
                if c_exc is not None:
                    if original_exception is None:
                        original_exception = c_exc
                    elif (
                        isinstance(original_exception, asyncio.CancelledError)
                        and original_exception.__cause__ is None
                    ):
                        original_exception.__cause__ = c_exc

        # Deterministic parent cancellation precedence during cleanup
        current_parent_cancelling = curr.cancelling() if curr else 0
        if cleanup_cancellation_count > 0 or current_parent_cancelling > initial_parent_cancelling:
            if isinstance(original_exception, asyncio.CancelledError):
                cancelled_err = original_exception
            else:
                cancelled_err = asyncio.CancelledError("Parent supervisor was cancelled.")
                if original_exception is not None:
                    cancelled_err.__cause__ = original_exception
            raise cancelled_err
