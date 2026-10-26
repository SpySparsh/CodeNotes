# CodeNotes FastAPI Production Runbook & Operations Guide

This runbook is the authoritative operational guide for deploying, configuring, verifying, monitoring, and rolling back the **FastAPI AI Generator Service** and its integration with the **CodeNotes Next.js** application and **Inngest** workflow engine.

---

## 1. System Architecture & Responsibility Boundaries

The CodeNotes AI generation pipeline decouples user interaction, durable orchestration, AI inference, and database persistence into dedicated tiers:

```mermaid
flowchart LR
    subgraph Client["Browser Tier"]
        UI["Next.js Web App"]
    end

    subgraph Orchestration["Application & Orchestration Tier (Vercel)"]
        API["POST /api/generate"]
        Inngest["Inngest Engine (/api/inngest)"]
        Adapter["Node AI Client (ai-client.ts)"]
    end

    subgraph Inference["AI Inference Tier (Vercel Project: codenotes-ai-generator)"]
        FastAPI["FastAPI Microservice (/api/v1/generate)"]
        GeminiSDK["google-genai SDK"]
    end

    subgraph External["External Cloud"]
        GeminiAPI["Google Gemini 2.5 Flash"]
    end

    subgraph Data["Persistence Tier (Supabase)"]
        Postgres[("PostgreSQL 16 (RLS Enforced)")]
    end

    UI -->|1. Submit URL| API
    API -->|2. Pending Idempotency Row| Postgres
    API -->|3. Dispatch Event| Inngest
    Inngest -->|Step 1: Lease| Postgres
    Inngest -->|Step 2: Transcript| Postgres
    Inngest -->|Step 3: generateAiNotes| Adapter
    Adapter -->|HTTPS + Bearer Secret + X-Request-ID| FastAPI
    FastAPI -->|Token verification & schema validation| FastAPI
    FastAPI -->|Async inference call| GeminiSDK
    GeminiSDK -->|API request| GeminiAPI
    GeminiAPI -->>|JSON response| GeminiSDK
    GeminiSDK -->>|Pydantic validation| FastAPI
    FastAPI -->>|200 OK + CamelCase JSON| Adapter
    Adapter -->>|Zod validation| Inngest
    Inngest -->|Step 4: Atomic withUserTransaction| Postgres
    UI -.->|Poll status| API
```

### Component Responsibility Breakdown

| Component | Host / Runtime | Responsibilities | Out of Scope / Boundaries |
| :--- | :--- | :--- | :--- |
| **Next.js Web App** | Vercel (Edge / Node) | User authentication (Supabase Auth), URL ingestion, rate-limiting, job registration, client-facing status polling, library rendering. | Does not execute Gemini inference directly. |
| **Inngest Workflow Engine** | Inngest Cloud + `/api/inngest` | Background job execution, durable step memoization, exponential retry backoff, stale generation reconciliation cron. | Does not store user passwords or raw database data. |
| **Node AI Client Adapter** ([`src/lib/ai-client.ts`](../src/lib/ai-client.ts)) | Vercel Serverless (Node 20) | Configuration validation, HTTPS enforcement, request ID normalization, Bearer authentication, timeout management (85s abort), Zod response parsing. | Does not maintain persistent state. |
| **FastAPI Microservice** ([`services/ai-generator`](../services/ai-generator)) | Vercel (Python 3.13) | Service Bearer token verification, input length validation, Technical Content Architect prompt construction, Gemini inference via `google-genai` SDK, Pydantic response validation, error code translation. | **Stateless compute only**. Does **not** connect to PostgreSQL, handle Supabase auth, or persist data. |
| **PostgreSQL Database** | Supabase (Postgres 16) | Atomic idempotency tracking (`generation_idempotency`), multi-tenant row-level security (`notes`), shared transcript caching (`youtube_transcripts`), rate limit buckets. | Does not invoke external APIs. |

---

## 2. Service Contract & API Specification

### Base Endpoints

- **`GET /health`**: Minimal passive health check.
  - **Auth**: None.
  - **Behavior**: Returns `{"status": "healthy"}` immediately without contacting Gemini or exposing configuration.
- **`POST /api/v1/generate`**: Technical study notes generation.
  - **Auth**: `Authorization: Bearer <FASTAPI_SERVICE_SECRET>`.
  - **Headers**:
    - `Authorization: Bearer <FASTAPI_SERVICE_SECRET>` (Required).
    - `X-Request-ID: <trace-id>` (Caller trace ID, sanitized to `^[a-zA-Z0-9_\-\.]{1,64}$`).
    - `x-vercel-protection-bypass: <secret>` (Required only when targeting a protected Vercel Preview deployment).
  - **Request Schema**:
    ```json
    {
      "videoTitle": "TypeScript Generics Tutorial",
      "transcript": "In this tutorial we learn interfaces, type aliases, and generic constraints..."
    }
    ```
    - `videoTitle` / `video_title`: string, 1 to 500 characters.
    - `transcript`: string, 10 to 500,000 characters.
  - **Response Schema (`200 OK`)**:
    ```json
    {
      "overview": "A compelling overview of the video's purpose (2-3 sentences).",
      "keyConcepts": ["Concept 1", "Concept 2"],
      "detailedNotes": "# Detailed Topics\n\n```typescript\nfunction id<T>(x: T): T { return x; }\n```\n",
      "shorthands": ["Use interfaces for public API contracts."]
    }
    ```

### Error Envelopes & Machine-Readable Codes

All error responses from FastAPI conform to the standardized schema `{"error": {"code": "CODE", "message": "Sanitized message"}}`:

| HTTP Status | Error Code | Trigger / Cause | Node Client Action | Inngest Retry? |
| :---: | :--- | :--- | :--- | :---: |
| **401** | `UNAUTHORIZED` | Missing, malformed, or mismatched Bearer token | Throws `CONFIG_ERROR` | **No** (`NonRetriableError`) |
| **422** | `INVALID_REQUEST` | Missing fields, title > 500 chars, transcript outside limits | Throws `INVALID_REQUEST` | **No** (`NonRetriableError`) |
| **429** | `RATE_LIMITED` | Upstream Gemini 429 quota exhaustion (`RESOURCE_EXHAUSTED`) | Throws `RATE_LIMITED` | **Yes** (exponential backoff) |
| **502** | `MALFORMED_OUTPUT` | Gemini returned unparseable JSON or schema-violating output | Throws `MALFORMED_AI_OUTPUT` | **No** (`NonRetriableError`) |
| **502** | `UPSTREAM_ERROR` | Upstream Google Gemini 503 Overloaded or gateway failure | Throws `UPSTREAM_ERROR` | **Yes** (exponential backoff) |
| **503** | `CONFIG_ERROR` | Server missing `GEMINI_API_KEY` or `FASTAPI_SERVICE_SECRET` | Throws `CONFIG_ERROR` | **No** (`NonRetriableError`) |
| **504** | `TIMEOUT` | Upstream Gemini request exceeded `GEMINI_TIMEOUT_MS` (75s) | Throws `TIMEOUT` | **Yes** (exponential backoff) |

---

## 3. Environment Variables & Secret Configuration

### Variable Allocation Matrix

| Variable Name | Required Where | Secret / Safe | Purpose & Rules |
| :--- | :--- | :---: | :--- |
| `FASTAPI_SERVICE_URL` | **CodeNotes** (Preview & Prod) | Safe URL | Base URL of the FastAPI microservice. Local: `http://127.0.0.1:8000`. **Production MUST use `https://`** pointing to the stable production domain (e.g. `https://codenotes-ai-generator.vercel.app`). |
| `FASTAPI_SERVICE_SECRET` | **Both** CodeNotes & FastAPI | **Secret** | Cryptographic shared token (minimum 32 random characters). Transmitted via `Authorization: Bearer <FASTAPI_SERVICE_SECRET>`. Must match identically across both projects. |
| `GEMINI_API_KEY` | **FastAPI only** | **Secret** | Google AI Studio API key used by the `google-genai` Python SDK. |
| `GEMINI_MODEL` | **FastAPI only** (Optional) | Safe | Model name. Default: `gemini-2.5-flash`. |
| `GEMINI_TIMEOUT_MS` | **FastAPI only** (Optional) | Safe | Outbound Gemini API timeout. Default: `75000` (75 seconds). |
| `FASTAPI_VERCEL_PROTECTION_BYPASS` | **CodeNotes** (Preview only) | **Secret** | Platform-level secret used to bypass Vercel Deployment Protection on FastAPI Preview deployments. Transmitted via `x-vercel-protection-bypass`. Leave empty in local and production. |

### Critical Distinction: Two Separate Vercel Protection Bypass Secrets

Do not confuse the two bypass mechanisms:
1. **`FASTAPI_VERCEL_PROTECTION_BYPASS` (Node $\to$ FastAPI)**:
   - Configured in CodeNotes environment variables.
   - Allows CodeNotes Preview deployments to call password-protected or Vercel-authenticated **FastAPI Preview** deployments.
2. **Inngest Protection Bypass (Inngest Cloud $\to$ CodeNotes `/api/inngest`)**:
   - Configured in the Inngest Dashboard under your app's webhook settings.
   - Allows Inngest's cloud executors to send HTTP requests to a password-protected **CodeNotes Preview** deployment.
   - These are separate secrets protecting different ingress boundaries and must never be mixed up.

### Stable Production URL Requirement

> [!IMPORTANT]
> In the CodeNotes Production Vercel project, `FASTAPI_SERVICE_URL` must point to the **canonical, stable Production URL** of the AI Generator (e.g. `https://codenotes-ai-generator.vercel.app`), **never** a branch-specific Preview deployment URL (e.g. `https://codenotes-ai-generator-git-feature-fastapi-xxx.vercel.app`).
>
> Branch preview URLs are ephemeral, subject to Vercel deployment protection locks, and will fail or be removed when pull requests are closed or pruned.

---

## 4. Production Deployment Procedure

### Phase A: Deploy / Update FastAPI Microservice (`codenotes-ai-generator`)

1. **Verify Vercel Project Settings**:
   - **Project Name**: `codenotes-ai-generator`
   - **Root Directory**: `services/ai-generator`
   - **Framework Preset**: `Other` / `FastAPI`
   - **Node.js / Python Runtime**: Python 3.13 (pinned via `.python-version` and `pyproject.toml`)
   - **Function `maxDuration`**: `90` seconds (configured in `services/ai-generator/vercel.json`)
2. **Configure Environment Variables in FastAPI Project**:
   In Vercel Dashboard $\to$ `codenotes-ai-generator` $\to$ **Settings $\to$ Environment Variables**:
   - `GEMINI_API_KEY`: Google AI Studio production API key.
   - `FASTAPI_SERVICE_SECRET`: High-entropy 32+ character random string.
   - `ENVIRONMENT`: `production`
   - `GEMINI_MODEL`: `gemini-2.5-flash`
   - `GEMINI_TIMEOUT_MS`: `75000`
3. **Deploy the Service**:
   Deploy from `main` or merge to `main`.
4. **Passive Health & Security Smoke Verification**:
   Execute from any authorized terminal:
   ```bash
   # 1. Passive Health Check (returns 200 without calling Gemini)
   curl -i https://<your-fastapi-prod-domain>.vercel.app/health
   # Expected: HTTP/2 200, {"status": "healthy"}, x-request-id header present

   # 2. Assert Unauthorized Rejection (returns 401)
   curl -i -X POST https://<your-fastapi-prod-domain>.vercel.app/api/v1/generate \
     -H "Content-Type: application/json" \
     -d '{"transcript": "test", "videoTitle": "test"}'
   # Expected: HTTP/2 401 Unauthorized, {"error": {"code": "UNAUTHORIZED"}}
   ```

### Phase B: Configure & Verify CodeNotes Production (`codenotes`)

1. **Configure Environment Variables in CodeNotes Project**:
   In Vercel Dashboard $\to$ `codenotes` $\to$ **Settings $\to$ Environment Variables**:
   - `FASTAPI_SERVICE_URL`: `https://<your-fastapi-prod-domain>.vercel.app` (must use `https://`)
   - `FASTAPI_SERVICE_SECRET`: Identical secret token configured in Phase A.
   - Confirm `FASTAPI_VERCEL_PROTECTION_BYPASS` is **not** set in Production.
2. **Deploy / Redeploy CodeNotes**:
   Trigger deployment on `main`.
3. **Verify Deployment Commit & Health**:
   Query the CodeNotes health probe:
   ```bash
   curl -i https://<your-codenotes-prod-domain>.vercel.app/api/health
   ```
   Assert:
   - HTTP status is `200 OK`.
   - `commit` matches the full 40-character SHA of your expected deployment.
   - `database` is `"connected"`.
   - `environment` is `"production"`.
4. **Verify Inngest App Synchronization**:
   - Open the [Inngest Cloud Dashboard](https://app.inngest.com).
   - Navigate to your production app.
   - Confirm that the app sync status is **Active** and points to `https://<your-codenotes-prod-domain>.vercel.app/api/inngest`.
   - Confirm that `generate-notes` and `reconcile-stale-generations` are registered and active.

---

## 5. End-to-End Post-Deployment Verification

Verify the entire real-world execution path:
$$\text{CodeNotes UI} \longrightarrow \text{Inngest Workflow} \longrightarrow \text{FastAPI POST} \longrightarrow \text{Gemini Inference} \longrightarrow \text{PostgreSQL Persistence} \longrightarrow \text{Rendered Note in UI}$$

### Step-by-Step UI Smoke Test

1. **Sign In**: Log into CodeNotes Production via email/password or Google OAuth.
2. **Submit a YouTube Tutorial URL**:
   - Enter a valid technical programming tutorial (e.g., a 2-to-5 minute video with English captions).
   - Click **Generate Notes**.
3. **Observe UI Polling Transitions**:
   - Confirm the UI transitions smoothly from `pending` $\to$ `processing` $\to$ `completed`.
   - Polling queries `/api/generate/status?key=<uuid>` every 1.5 seconds.
4. **Verify Rendered Output**:
   - Confirm the browser navigates to `/notes/<noteId>`.
   - Verify that all four structured sections render correctly:
     - Overview summary paragraph.
     - Key Concepts bullet list.
     - Detailed Topics with formatted syntax-highlighted code blocks and comparison tables.
     - Shorthands and quick tips.
5. **Verify Library Persistence**:
   - Navigate to `/library`.
   - Confirm the new note appears in your library list with accurate title, tags, and timestamp.
6. **Cross-Service Log Correlation Verification**:
   - Copy the `idempotencyKey` from the browser network request (`POST /api/generate` payload or `Idempotency-Key` header).
   - Search Vercel Runtime Logs for `codenotes` using the key. Confirm `ai_client_request_started` and `ai_client_request_completed` log events contain `requestId: "<key>"`.
   - Search Vercel Runtime Logs for `codenotes-ai-generator` using the key. Confirm structured logs reflect `requestId: "<key>"` and report successful token generation and schema validation.

---

## 6. Honest Reliability, Retries & Failure Limitations

The following statements reflect the real guarantees and limitations established by the source code and the Phase 5 Reliability Audit:

### Guarantees Enforced by Code & Database Constraints

1. **Zero Duplicate Note Writes**:
   - Enforced by PostgreSQL transactional locking (`SELECT ... FOR UPDATE` on `generation_idempotency` within `withUserTransaction`).
   - If an Inngest step replays after notes have already been inserted, the transaction detects `status = 'completed'` and exits immediately as a safe no-op. Multiple note rows are never written for the same idempotency key.
2. **Bounded Retry Execution**:
   - Inngest function `retries: 2` guarantees that a failing step will be retried at most twice (3 total attempts).
   - Functions never retry indefinitely.
3. **Immediate Fail-Fast for Deterministic Errors**:
   - Configuration errors (401/403/503), invalid payloads (422), and malformed AI outputs are converted to `NonRetriableError` via [`classifyError()`](../src/inngest/functions/generate-notes.ts). They fail immediately without burning retry budgets or issuing repeated Gemini inference calls.
4. **Step Memoization**:
   - Inngest memoizes the output of each completed step. If Step 4 fails due to a transient database disconnect, Inngest replays Step 4 using the memoized return value of Step 3 without calling FastAPI or Gemini again.

### Documented Operational Limitations

1. **FastAPI Does Not Enforce Deduplication**:
   - FastAPI is purely stateless compute. It possesses no database, Redis instance, or persistent cache.
   - The `X-Request-ID` header is used for log correlation and tracing only; **it does not deduplicate inference requests on FastAPI**.
2. **The Ambiguous-Success Failure State (Repeated Gemini Inference Cost)**:
   - If Gemini completes inference successfully (e.g. taking 70s), but the HTTP connection drops or times out before Inngest durably memoizes the Step 3 output, Inngest treats Step 3 as failed and retries it.
   - On retry, Inngest executes Step 3 again, dispatching a new HTTP request to FastAPI and calling Gemini a second time.
   - **Cost impact**: An additional Gemini inference call is billed.
   - **Database impact**: Zero duplicate notes are written because Step 4's database transaction prevents duplicate insertion.
3. **Single Secret Rotation Window**:
   - The current architecture uses a single shared secret (`FASTAPI_SERVICE_SECRET`). Rotating this secret in production causes a brief mismatch (~30–60s) during deployment propagation, which will reject in-flight requests with HTTP 401. Since HTTP 401 is non-retryable, in-flight jobs will fail. Secret rotations should be scheduled during maintenance windows.

---

## 7. Diagnostic & Troubleshooting Guide

### Issue 1: HTTP 503 `CONFIG_ERROR`
- **Symptom**: Inngest fails Step 3 immediately; error log displays `FASTAPI_SERVICE_SECRET is not configured or is a placeholder`.
- **Diagnosis**:
  - CodeNotes or FastAPI has `FASTAPI_SERVICE_SECRET` unset or set to the default placeholder.
- **Resolution**:
  - Generate a 32+ character random secret (`node -e "console.log(crypto.randomBytes(32).toString('hex'))"`).
  - Update `FASTAPI_SERVICE_SECRET` in both Vercel project settings and redeploy.

### Issue 2: HTTP 401 `UNAUTHORIZED`
- **Symptom**: Inngest logs `Invalid service authentication credentials`.
- **Diagnosis**:
  - `FASTAPI_SERVICE_SECRET` in CodeNotes does not match `FASTAPI_SERVICE_SECRET` in FastAPI.
  - Or, an unauthenticated request reached a protected endpoint.
- **Resolution**:
  - Re-copy the exact secret between both Vercel project dashboards. Never log or expose secrets.

### Issue 3: HTTP 401 / 403 on Vercel Preview URL
- **Symptom**: CodeNotes Preview deployment fails to call FastAPI Preview deployment with HTML error from Vercel edge proxy.
- **Diagnosis**:
  - Vercel Deployment Protection is enabled on the FastAPI preview project, but `FASTAPI_VERCEL_PROTECTION_BYPASS` is unset or mismatched in CodeNotes.
- **Resolution**:
  - Copy the Protection Bypass for Automation secret from FastAPI Vercel Project Settings to CodeNotes `FASTAPI_VERCEL_PROTECTION_BYPASS`.

### Issue 4: HTTP 504 Gateway Timeout or Node `AbortError`
- **Symptom**: Inngest step logs `AI generation timed out after 85 seconds`.
- **Diagnosis**:
  - Video transcript was exceptionally long, or Google Gemini experienced upstream queueing delays exceeding 75 seconds.
- **Resolution**:
  - Check Gemini API status dashboard for service degradation.
  - Inngest will automatically retry transient timeouts up to 2 times with exponential backoff.

### Issue 5: Step 4 Database Persistence Failure
- **Symptom**: Step 3 succeeds, but job fails on Step 4 with `connection pool exhausted` or `statement timeout`.
- **Diagnosis**:
  - Supabase database connection pool reached maximum capacity.
- **Resolution**:
  - Inngest will retry Step 4 automatically. Step 3's output is memoized, so Gemini is not recalled.
  - Verify Supabase connection pool settings or consider using connection pooling port (6543) with `DATABASE_CA_CERT`.

---

## 8. Safe Rollback Procedure

If the FastAPI integration experiences critical failure in Production, execute one of the following rollback paths:

### Rollback Path 1: Instant Vercel Deployment Rollback (Fastest, < 1 minute)

1. Open the **CodeNotes Vercel Project Dashboard**.
2. Navigate to the **Deployments** tab.
3. Locate the previous stable production deployment commit.
4. Click the three dots `...` and select **Rollback to this Deployment** (or promote to production).
5. Vercel instantly routes 100% of production traffic to the previous build artifact.

### Rollback Path 2: Microservice Rollback

If the fault is isolated to a new change in `services/ai-generator`:
1. Open the **`codenotes-ai-generator` Vercel Project Dashboard**.
2. Navigate to **Deployments** and promote the previous stable deployment.
3. CodeNotes will immediately begin communicating with the previous FastAPI version without requiring a frontend redeploy.

### Rollback Path 3: Git-Based Revert

If a deployment rollback must be codified in Git history:
1. Revert the merge commit on `main`:
   ```bash
   git revert -m 1 <merge-commit-sha>
   git push origin main
   ```
2. GitHub Actions CI will run all validation gates and deploy the clean revert commit to production.
3. Post-deployment smoke tests will assert the new commit SHA at `/api/health`.
