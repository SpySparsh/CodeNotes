# CodeNotes AI Generator Service

Standalone FastAPI microservice responsible for generating structured technical study notes from YouTube tutorial transcripts using the official `google-genai` SDK and Gemini 2.5 Flash.

---

## 1. Architecture & Boundaries

```
[ Next.js / Inngest Workflow ]
             │
             │  POST /api/v1/generate
             │  Header: Authorization: Bearer <FASTAPI_SERVICE_SECRET>
             │  Header: X-Request-ID: <trace-id>
             ▼
[ FastAPI AI Generator Service ]
   ├── Verify Service Bearer Token (constant-time compare)
   ├── Validate Input Payload (transcript, videoTitle)
   ├── Construct Technical Content Architect Prompt
   ├── Invoke Google Gemini (gemini-2.5-flash) via google-genai SDK (75s timeout)
   ├── Parse & Validate JSON into Pydantic schema
   └── Return camelCase response: { overview, keyConcepts, detailedNotes, shorthands }
```

- **Scope**: The AI generator service is a **stateless compute microservice**.
- **Boundaries**: It does **not** connect to PostgreSQL, authenticate end users, handle Supabase sessions, or persist notes. All workflow orchestration, rate-limiting, and note persistence remain in Node.js.
- **Deduplication Reality**: The service does **not** maintain an idempotency cache. Passing an `X-Request-ID` binds that identifier to request logging and response headers for distributed tracing, but does **not** deduplicate inference requests on FastAPI.

---

## 2. API Reference

### `GET /health`

Minimal passive health-check endpoint. Does not invoke Gemini or expose configuration.

- **Authentication**: None required.
- **Response**: HTTP 200 OK
  ```json
  {
    "status": "healthy"
  }
  ```

---

### `POST /api/v1/generate`

Generates premium structured technical study notes.

- **Authentication**: `Authorization: Bearer <FASTAPI_SERVICE_SECRET>` (Required).
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <FASTAPI_SERVICE_SECRET>`
  - `X-Request-ID: <optional-trace-id>`: Caller-provided trace identifier. Validated against `^[a-zA-Z0-9_\-\.]{1,64}$`. If omitted, oversized (>64 chars), or containing unsafe/newline characters, it is safely replaced with a server-generated UUID4.
  - `x-vercel-protection-bypass: <secret>`: Required only when targeting a Vercel-protected Preview deployment.

#### Request Payload

Accepts either `videoTitle` (camelCase) or `video_title` (snake_case).

```json
{
  "videoTitle": "TypeScript Generics Tutorial",
  "transcript": "In this tutorial we learn interfaces, type aliases, and generic constraints in TypeScript..."
}
```

| Field | Type | Limits | Description |
| :--- | :---: | :---: | :--- |
| `videoTitle` / `video_title` | `string` | 1 – 500 chars | Title of the YouTube video. |
| `transcript` | `string` | 10 – 500,000 chars | Extracted transcript text (~100k words, up to ~5h tutorial). |

#### Response Payload (HTTP 200 OK)

Output strictly serializes in camelCase to match the existing Node.js `GeneratedNotes` contract:

```json
{
  "overview": "A compelling overview of the video's purpose (2-3 sentences).",
  "keyConcepts": [
    "Interfaces vs Type Aliases",
    "Generic Constraints using extends",
    "Declaration Merging"
  ],
  "detailedNotes": "# Detailed Topics\n\n## 1. Generics\n\nInline code example:\n\n```typescript\nfunction identity<T>(arg: T): T {\n  return arg;\n}\n```\n\n| Feature | Interface | Type Alias |\n|---|---|---|\n| Declaration Merging | Yes | No |\n",
  "shorthands": [
    "Use interfaces for object shapes and public APIs.",
    "Use type aliases for unions, primitives, and tuples."
  ]
}
```

| Field | Type | Required | Parity with `src/lib/gemini.ts` |
| :--- | :---: | :---: | :--- |
| `overview` | `string` | **Yes** | 2-3 sentences summarizing the video. |
| `keyConcepts` | `string[]` | **Yes** | Array of key concepts. Allows empty array `[]` (no `min_length` constraint). |
| `detailedNotes` | `string` | **Yes** | Exhaustive markdown string with contextual inline code blocks and comparison tables. |
| `shorthands` | `string[]` | **Yes** | Array of shorthands and quick tips. Required property; allows empty array `[]`. |

---

## 3. Client Lifecycle & Connection Pooling

- **FastAPI Lifespan Management**: `GeminiNoteGenerator` is created once during application startup via FastAPI's `lifespan` context manager and stored in `app.state.generator`.
- **Connection Pooling**: Outbound HTTP/gRPC client connections are initialized once per worker process and reused across requests via the `get_generator` application-scoped dependency. Requests never spawn redundant client instances.
- **Graceful Shutdown**: On process termination, `lifespan` awaits `generator.aclose()`, which closes underlying asynchronous sessions (`client.aio.aclose()`) and synchronous resources (`client.close()`).

---

## 4. Error Contract & Status Code Mapping

All errors return a standardized JSON envelope:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Sanitized error message."
  }
}
```

| HTTP Status | Error Code (`error.code`) | Description / Trigger |
| :---: | :--- | :--- |
| **401** | `UNAUTHORIZED` | Missing, malformed, or invalid Bearer token. |
| **422** | `INVALID_REQUEST` | Missing required fields, or transcript/title outside length limits. |
| **429** | `RATE_LIMITED` | Upstream Gemini 429 rate limit or quota exceeded (`RESOURCE_EXHAUSTED`). |
| **502** | `MALFORMED_OUTPUT` | Gemini returned unparseable JSON or schema-violating output. |
| **502** | `UPSTREAM_ERROR` | Upstream Google Gemini service failure (e.g. 503 Overloaded). |
| **503** | `CONFIG_ERROR` | Server missing required `GEMINI_API_KEY` or `FASTAPI_SERVICE_SECRET`. |
| **504** | `TIMEOUT` | Upstream Gemini API call timed out (default 75s). |

---

## 5. Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `GEMINI_API_KEY` | **Yes** | — | Google Gemini API key from Google AI Studio. |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model name for note generation. |
| `FASTAPI_SERVICE_SECRET` | **Yes** | — | Internal shared secret Bearer token. Must not be empty or placeholder. |
| `GEMINI_TIMEOUT_MS` | No | `75000` | Gemini outbound request timeout in milliseconds (75s). |
| `HOST` | No | `0.0.0.0` | Server bind host. |
| `PORT` | No | `8000` | Server bind port. |
| `ENVIRONMENT` | No | `development` | Runtime environment name. |

---

## 6. Setup & Development Commands

### 1. Create Virtual Environment & Install Dependencies

The authoritative dependency workflow uses `uv` with `pyproject.toml` and `uv.lock`:

```bash
# Authoritative locked installation (matches CI and Vercel):
uv sync

# Or using standard pip with editable install:
python -m venv .venv
# Windows:
.\.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

pip install -e .[dev]
```

### 2. Run the Development Server

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
# Or using uv directly:
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

### 3. Run Automated Tests

All tests execute against mocked Gemini responses (zero live AI requests, no billing):

```bash
pytest
# Or using uv directly:
uv run pytest
```

### 4. Code Formatting & Linting (Ruff)

```bash
ruff check .
ruff format --check .
# Or using uv directly:
uv run ruff check .
uv run ruff format --check .
```

### 5. Authoritative Dependency Management & Lockfile Consistency (uv)

The single source of truth for dependencies is `pyproject.toml` and `uv.lock`. Both CI and Vercel install directly from this locked configuration.

To check for lockfile consistency:

```bash
uv lock --check
```

To update dependencies or regenerate the lockfile after modifying `pyproject.toml`:

```bash
uv lock
uv sync
```

---

## 7. Cross-Process HTTP Boundary Verification

To verify real loopback HTTP communication between Node.js and FastAPI without making live Gemini calls or incurring billing:

```bash
# From workspace root:
npm run test:fastapi-boundary
# or directly with Vitest:
npx vitest run tests/fastapi-boundary.test.ts
```

This starts `tests/mock_server.py` on loopback port `18088`/`18090`, verifies `/health`, unauthenticated rejection (401), schema validation (422), camelCase note deserialization, `X-Request-ID` correlation preservation, upstream rate-limit mapping (429), and timeout enforcement.

---

## 8. Troubleshooting & Operational Safeguards

1. **Log Correlation Across Services**:
   Incoming request headers are validated against `^[a-zA-Z0-9_\-\.]{1,64}$`. Both Node.js and FastAPI log the correlation ID in structured JSON entries. If a caller supplies an invalid ID, Node.js sanitizes it before outbound transmission, and FastAPI echoes it in `x-request-id` response headers.
2. **Missing or Default Secret (HTTP 503 `CONFIG_ERROR`)**:
   If `FASTAPI_SERVICE_SECRET` is unset or set to the default placeholder (`change_me_to_a_secure_random_string`), the service refuses all generation requests and returns HTTP 503. Ensure `.env` contains a matching 32+ character random secret in both the Next.js and FastAPI environments.
3. **Timeout Hierarchy & Alignment**:
   - **Gemini Outbound API Timeout**: `75 seconds` (`GEMINI_TIMEOUT_MS=75000`). If Gemini takes longer than 75s to complete generation, FastAPI's internal client cancels the request and returns structured HTTP 504 `TIMEOUT`.
   - **Node.js Client Abort Timeout**: `85 seconds` (`DEFAULT_AI_TIMEOUT_MS=85000` in `src/lib/ai-client.ts`). The Node.js client grants FastAPI 10 seconds of headroom beyond Gemini's 75s limit to format and transmit its structured HTTP 504 error response before an `AbortError` cuts the socket.
   - **Vercel Serverless Function `maxDuration`**: `90 seconds` (configured in `vercel.json`). This 90s execution envelope gives a 15-second buffer beyond Gemini and 5 seconds beyond the Node.js client abort timer, preventing Vercel's edge proxy from abruptly cutting the connection with a generic reverse proxy error.
4. **Stateless Compute & The Ambiguous-Success Edge Case**:
   - FastAPI possesses no persistent storage or database.
   - If a network drop occurs after Gemini finishes inference but before Inngest durably memoizes the HTTP response, Inngest will retry Step 3, resulting in a second call to Gemini.
   - Database row-level locking on `generation_idempotency` in Node.js prevents duplicate note writes in PostgreSQL.

---

## 9. Vercel Deployment Configuration (Separate Project)

The FastAPI AI Generator is designed to be deployed as an independent Vercel project pointing to the `services/ai-generator/` subdirectory of the CodeNotes repository.

### Project Settings in Vercel Dashboard

When creating the separate Vercel project:

| Setting | Value | Notes |
| :--- | :--- | :--- |
| **Project Name** | `codenotes-ai-generator` | Separate project name from the frontend application |
| **Root Directory** | `services/ai-generator` | **Critical**: Points build & function detection to this directory |
| **Framework Preset** | Other / FastAPI | Automatically detected |
| **Runtime / Python** | Python 3.13 | Explicitly pinned in `.python-version` and `pyproject.toml` |
| **Entrypoint** | `app.main:app` | Configured via `[tool.vercel]` in `pyproject.toml` |
| **Function Timeout** | 90 seconds | Configured via `vercel.json` (`maxDuration: 90`). |

### Environment Variables for Vercel Project

Configure the following variables in the FastAPI project settings under **Settings -> Environment Variables**:

| Variable | Environment | Example Value / Description |
| :--- | :---: | :--- |
| `GEMINI_API_KEY` | Preview, Production | Google AI Studio Gemini API key (`AIza...`) |
| `GEMINI_MODEL` | Preview, Production | `gemini-2.5-flash` |
| `GEMINI_TIMEOUT_MS` | Preview, Production | `75000` (75s outbound API timeout) |
| `FASTAPI_SERVICE_SECRET` | Preview, Production | High-entropy shared secret (minimum 32 random characters) |
| `ENVIRONMENT` | Preview: `preview`, Production: `production` | Runtime environment name |

### Stable Production URL Requirement

> [!IMPORTANT]
> The main CodeNotes Production application must be configured with the **canonical Production URL** of the FastAPI service (e.g. `https://codenotes-ai-generator.vercel.app`), **never** a temporary Preview deployment URL.
>
> Preview URLs are tied to specific Git branches or pull requests and are removed or broken when branches are deleted or merged.

### Vercel Deployment Protection & Automation Bypass (Preview Deployments)

When Vercel Deployment Protection (Vercel Authentication or Password Protection) is active on Preview deployments:
- Inbound requests to the FastAPI preview deployment from automated clients (e.g. Next.js Preview or CI smoke tests) must include the `x-vercel-protection-bypass` header containing the bypass secret configured in **Vercel Dashboard -> Project Settings -> Deployment Protection -> Protection Bypass for Automation**.
- In the Next.js calling application, this secret is configured as `FASTAPI_VERCEL_PROTECTION_BYPASS`.
- **Two Distinct Secrets**:
  - `FASTAPI_SERVICE_SECRET`: Application-level secret sent via `Authorization: Bearer <FASTAPI_SERVICE_SECRET>` to authenticate directly with FastAPI.
  - `FASTAPI_VERCEL_PROTECTION_BYPASS`: Platform-level secret sent via `x-vercel-protection-bypass: <FASTAPI_VERCEL_PROTECTION_BYPASS>` to bypass Vercel deployment protection on preview URLs.
  - These are separate secrets protecting different ingress boundaries and must never be mixed up with the Inngest deployment protection bypass key.

---

## 10. Shared Secret Generation & Rotation

### Generating a Secure Shared Secret

```bash
# Using OpenSSL:
openssl rand -hex 32

# Or using Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Single-Secret Maintenance Window Rotation

The current service verifies credentials against a single `FASTAPI_SERVICE_SECRET`. Mismatched tokens immediately return HTTP 401 `UNAUTHORIZED`.
In the Node.js client (`src/lib/ai-client.ts`), HTTP 401 is mapped to `CONFIG_ERROR` with `isRetryable: false`. Inngest halts immediately via `NonRetriableError`.

Secret rotations must be executed during a **scheduled maintenance window** when no background generation jobs are running. For complete step-by-step procedures, consult the [FastAPI Production Runbook](../../docs/fastapi-production-runbook.md).

---

## 11. Preview Deployment Verification Checklist

When a preview deployment is created in Vercel:

1. **Passive Health Check (Zero Cost, No Gemini Call)**:
   ```bash
   curl -i https://<preview-domain>.vercel.app/health
   # Expected: HTTP 200 OK, {"status": "healthy"}, x-request-id header present
   ```
2. **Security Audit: Unauthenticated Rejection**:
   ```bash
   curl -i -X POST https://<preview-domain>.vercel.app/api/v1/generate \
     -H "Content-Type: application/json" \
     -d '{"transcript": "test", "videoTitle": "test"}'
   # Expected: HTTP 401 Unauthorized, {"error": {"code": "UNAUTHORIZED"}}
   ```
3. **Security Audit: Invalid Token Rejection**:
   ```bash
   curl -i -X POST https://<preview-domain>.vercel.app/api/v1/generate \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer wrong-token" \
     -d '{"transcript": "test", "videoTitle": "test"}'
   # Expected: HTTP 401 Unauthorized
   ```
4. **Validation Audit: Schema Enforcement**:
   ```bash
   curl -i -X POST https://<preview-domain>.vercel.app/api/v1/generate \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <FASTAPI_SERVICE_SECRET>" \
     -d '{}'
   # Expected: HTTP 422 Unprocessable Entity, {"error": {"code": "INVALID_REQUEST"}}
   ```
5. **Log Privacy Audit**:
   - Inspect Vercel Runtime Logs for test requests.
   - Confirm transcripts, prompts, and `Authorization` Bearer tokens are **never logged**.
   - Confirm structured JSON logs contain `requestId`, `level`, and `timestamp`.
