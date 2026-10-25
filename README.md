# CodeNotes AI

CodeNotes is an AI-powered technical study-notes application that transforms YouTube programming tutorials into structured, syntax-highlighted study notes. A user submits a YouTube URL; the system validates the input, authenticates via Supabase Auth, registers a durable idempotency reservation in PostgreSQL, and dispatches a background event to Inngest.

Inngest durable steps fetch the video transcript using a dual-provider strategy (Supadata API primary with `youtube-transcript` fallback) and shared PostgreSQL transcript caching, invoke Google Gemini 2.5 Flash with structured schema enforcement, and atomically persist the study notes to PostgreSQL under Row Level Security (RLS) user isolation. The frontend provides live status polling and a keyset-paginated library with full search and sorting.

---

## Key Highlights & Architecture

- **Durable Serverless Execution**: Eliminates the operational overhead of persistent worker VMs, Redis, or BullMQ by utilizing Inngest serverless step functions.
- **Distributed Idempotency & Processing Leases**: Guarantees zero duplicate note writes and safe retries across network drops and concurrent requests via PostgreSQL `generation_idempotency` records with 15-minute leases.
- **Multi-Tenant PostgreSQL Row Level Security (RLS)**: Enforces complete user isolation directly at the database layer via `withUserTransaction` and transaction-local JWT claims (`SET LOCAL "request.jwt.claim.sub"`).
- **Dual-Provider Transcript Strategy & Shared Caching**: Reuses public transcripts across users in `youtube_transcripts` while keeping generated notes strictly isolated. Falls back cleanly from Supadata to YouTube scraping.
- **Crash-Safe Reconciliation**: A 5-minute Inngest cron job scans stale `pending` and `processing` records, re-dispatching dropped jobs to ensure zero orphaned user requests.
- **Full Observability Stack**: Built-in Prometheus metrics at `/api/metrics`, Prometheus alerting rules, pre-configured Grafana dashboard, deep `/api/health` probes, and privacy-safe Sentry error sanitization.

```text
Browser Tier (React 19 / TanStack Query)
  │
  ├── 1. POST /api/generate ──► Auth & Rate Limit ──► Write 'pending' DB row ──► Return 202 Accepted
  │                                                                 │
  │                                                                 ▼
  │                                                     Dispatch Inngest Event
  │                                                                 │
  └── 2. Polling /api/generate/status                               ▼
                                                        Inngest Serverless Engine (/api/inngest)
                                                                    │
                                                                    ├── Step 1: Claim 15-min lease (PostgreSQL)
                                                                    ├── Step 2: Fetch transcript (Cache / Supadata / Scraper)
                                                                    ├── Step 3: Invoke FastAPI AI Generator
                                                                    │          (POST /api/v1/generate ──► Gemini 2.5 Flash)
                                                                    └── Step 4: Atomic RLS commit (notes table)
```

For detailed component flows and sequence diagrams, see the [Architecture Documentation](docs/architecture.md).

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Framework & UI** | Next.js 16.3 (App Router, Turbopack), React 19, TypeScript 5, Tailwind CSS |
| **State & Polling** | TanStack Query v5, Zustand v5, React Hook Form, Zod |
| **Durable Execution** | Inngest (`inngest`, `inngest/next`) |
| **Database & Auth** | PostgreSQL 16 (Supabase), Row Level Security (RLS), `pg` connection pool |
| **AI & Transcripts** | Google Gemini 2.5 Flash (`@google/generative-ai`), Supadata API, `youtube-transcript` |
| **Observability** | Prometheus (`prom-client`), Grafana, `@sentry/nextjs`, structured JSON logging |
| **Testing** | Vitest, Playwright, Docker Compose |

---

## Project Documentation

Detailed technical documentation is available in the `docs/` directory:

- 📖 **[Architecture Guide](docs/architecture.md)**: Deep dive into synchronous ingestion vs. durable execution, Mermaid architecture and sequence diagrams, database schema, RLS policies, distributed idempotency, and reconciliation.
- 🛠️ **[Development & Testing Guide](docs/development.md)**: Prerequisites, local setup instructions, environment variables reference, migrations, and running the test suites (unit, integration, RLS, E2E, and observability).
- 📊 **[Observability & Monitoring Guide](docs/observability.md)**: Prometheus metrics reference, alerting rules, Grafana dashboard panels, process-local scraping limitations in serverless, health checks, and Sentry PII sanitization.

---

## Local Development Setup

### 1. Prerequisites
- **Node.js**: `v20.x` or higher
- **PostgreSQL**: `16.x` (local instance or Supabase)
- **Docker Compose**: Required for running the Prometheus/Grafana stack and RLS test containers

### 2. Install Dependencies
Due to a peer dependency requirement between Vitest 5 and `@types/node 20`, install dependencies using `--legacy-peer-deps`:
```bash
npm install --legacy-peer-deps
# or for clean CI installations
npm ci --legacy-peer-deps
```

### 3. Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```
Set your database and API keys:
```env
DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5432/codenotes
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
GEMINI_API_KEY=your-gemini-api-key
FASTAPI_SERVICE_URL=http://127.0.0.1:8000
FASTAPI_SERVICE_SECRET=your-fastapi-service-secret
# FASTAPI_VERCEL_PROTECTION_BYPASS is required only when calling a Vercel-protected FastAPI Preview deployment:
# FASTAPI_VERCEL_PROTECTION_BYPASS=your-vercel-protection-bypass-secret
SUPADATA_API_KEY=your-optional-supadata-key
# METRICS_SECRET is optional locally (leave unset or commented out for unauthenticated local Prometheus scraping)
# METRICS_SECRET=your-metrics-secret
```

### 4. Run Database Migrations
Apply the atomic schema migration:
```bash
npm run db:migrate
```

> [!NOTE]
> Database migrations acquire a transaction-scoped PostgreSQL advisory lock (`7892348912734912`) to serialize concurrent migration runs safely, and abort if unowned legacy records are detected. Migrations are executed manually and do not run automatically during Vercel builds. See [docs/development.md](docs/development.md) for details.

### 5. Start Development Servers (Multi-Service Workflow)

To develop with live AI generation, start the multi-service stack in separate terminals:

```bash
# Terminal 1: Next.js Web App (Turbopack)
npm run dev

# Terminal 2: Inngest Local Dev Server
npm run inngest:dev

# Terminal 3: FastAPI AI Generator Microservice
cd services/ai-generator
# Windows:
.\.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 4 (Optional): Prometheus & Grafana Monitoring Stack
docker compose -f docker-compose.prometheus.yml up -d
```

- **Next.js Web App**: [http://localhost:3000](http://localhost:3000)
- **Inngest Dashboard**: [http://localhost:8288](http://localhost:8288)
- **FastAPI AI Service**: [http://localhost:8000/health](http://localhost:8000/health)
- **Prometheus**: [http://localhost:9090](http://localhost:9090)
- **Grafana**: [http://localhost:3001](http://localhost:3001) (`admin` / `admin`)

> [!TIP]
> **Native Execution vs. Docker Compose**: For local development, running Next.js, Inngest, and FastAPI natively on the host machine provides the fastest hot-reload feedback, sub-second Turbopack compilation, and instant Python reloads without container translation overhead. Docker Compose is recommended for supporting background infrastructure (Prometheus/Grafana) or isolated staging runs.

---

## Quality & Testing Gates

CodeNotes enforces automated quality checks covering the full testing pyramid:

```bash
# 1. Run all Node.js unit and integration tests (Vitest)
npm test

# 2. Run real loopback cross-process FastAPI boundary verification
npm run test:fastapi-boundary

# 3. Run Python unit and integration tests (Pytest)
cd services/ai-generator && pytest && cd ../..

# 4. Check Python linting and formatting (Ruff)
ruff check services/ai-generator
ruff format --check services/ai-generator

# 5. Run PostgreSQL Row Level Security (RLS) integration tests
# (Requires TEST_DATABASE_URL pointing to isolated local 'codenotes_test' database)
npm run test:integration:rls

# 6. Validate Prometheus config, alert rules, and Grafana dashboard queries
npm run validate:observability

# 7. Run deterministic Playwright end-to-end tests
npm run test:e2e

# 8. Linting and TypeScript type checking
npm run lint
npx tsc --noEmit

# 9. Production Next.js build compilation
npm run build
```

---

## API Reference

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `POST` | `/api/generate` | Dispatch a note generation job (authenticated, returns 202 Accepted or 200 cached replay) |
| `GET` | `/api/generate/status` | Poll generation status (`pending`, `processing`, `completed`, `failed`) |
| `GET/POST/PUT` | `/api/inngest` | Inngest serve handler for serverless step execution and cron schedules |
| `GET` | `/api/notes` | List saved notes with keyset cursor pagination, search, and sorting |
| `GET` | `/api/notes/[id]` | Retrieve a single note by UUID (authenticated, RLS-scoped) |
| `DELETE` | `/api/notes/[id]` | Delete a note by UUID (authenticated, RLS-scoped) |
| `GET` | `/api/health` | Active database probe (`SELECT 1`) returning connectivity and release metadata |
| `GET` | `/api/metrics` | Prometheus metrics endpoint (requires `METRICS_SECRET` Bearer auth in Preview/Production) |

### Health Probe & Release Metadata (`/api/health`)

CodeNotes exposes an active database liveness probe at `/api/health` returning an `x-request-id` header:

- **Healthy (`200 OK`)**:
  ```json
  {
    "status": "healthy",
    "timestamp": "2026-10-24T18:00:00.000Z",
    "database": "connected",
    "commit": "<full-40-character-commit-sha>",
    "environment": "production"
  }
  ```
- **Unhealthy (`503 Service Unavailable`)**:
  ```json
  {
    "status": "unhealthy",
    "timestamp": "2026-10-24T18:00:00.000Z",
    "database": "disconnected",
    "commit": "<full-40-character-commit-sha>",
    "environment": "production"
  }
  ```

> [!IMPORTANT]
> - `commit` exposes the full 40-character Git commit SHA from `VERCEL_GIT_COMMIT_SHA` in deployed environments (or `null` in local development when unset).
> - To prevent sensitive information disclosure, database query latency (`durationMs`) and internal error details (`errorMessage`) are **never returned in the JSON response body**.
> - Query latency is recorded in Prometheus metrics (`http_request_duration_seconds`), and failures are emitted with structured error fields (including `errorMessage` and `status`) to stderr via JSON logs (`logger.error`). Prometheus records only low-cardinality status codes and labels; it does not store internal error strings.

### Metrics Scraping & Authentication (`/api/metrics`)

The Prometheus metrics endpoint exposes HTTP, pipeline, and AI telemetry:
- **Preview & Production**: Requires `Authorization: Bearer <METRICS_SECRET>`. Missing or invalid tokens return HTTP `401 Unauthorized`. If `METRICS_SECRET` is unset or blank in preview/production, the endpoint fails closed with HTTP `503 Service Unavailable`.
- **Local Development**: If `METRICS_SECRET` is unset or blank, `/api/metrics` allows unauthenticated scraping to simplify local Docker Prometheus development.

---

## Deployment & Verification Workflows

CodeNotes uses a multi-project deployment architecture on Vercel:

1. **Next.js Web Application (Project Root: `.`)**:
   - Deployed at `https://my-code-note.vercel.app` (or custom domain).
   - Manages frontend UI, Supabase authentication, rate limiting, and Inngest durable workflows.
   - Points to the FastAPI service via `FASTAPI_SERVICE_URL` (`https://...`) and `FASTAPI_SERVICE_SECRET`.
2. **FastAPI AI Generator (Project Root: `services/ai-generator`)**:
   - Deployed as an independent Vercel project linked to the same Git repository.
   - Configured with `[tool.vercel] entrypoint = "app.main:app"`, `.python-version` (3.13), and `maxDuration: 90` in `vercel.json` (within the 300s Hobby maximum when Fluid Compute is enabled, or up to 800s on Pro/Enterprise; verify project Fluid Compute settings).
   - Recommended region is `iad1` as a provisional default; confirm against actual Next.js and Supabase project regions in the respective cloud dashboards to minimize network latency.
   - Complete setup and environment variable instructions are documented in [services/ai-generator/README.md](services/ai-generator/README.md#9-vercel-deployment-configuration-separate-project).
3. **Automated Post-Deployment Smoke Verification**:
   The GitHub Actions workflow [`.github/workflows/post-deploy-smoke.yml`](.github/workflows/post-deploy-smoke.yml) triggers automatically on `workflow_run` after CI completes successfully on pushes to `main`. It polls `https://my-code-note.vercel.app/api/health` every 15 seconds for up to 10 minutes, asserting:
   - HTTP status code is `200`.
   - `commit` matches the exact full 40-character Git commit SHA that triggered the workflow.
   - `environment` equals `'production'`.
   - `status` equals `'healthy'`.
   - `database` equals `'connected'`.
4. **Manual Release Verification**:
   Inspect active health and the deployed full commit SHA via curl:
   ```bash
   curl -i https://my-code-note.vercel.app/api/health
   ```

---

## Operational Notes & Boundaries

1. **Process-Local Prometheus Metrics**: The in-memory Prometheus registry in `/api/metrics` reflects metrics for the local Node.js process. In distributed or serverless multi-instance deployments (such as Vercel), scraping process-local memory does not provide global aggregation without an external aggregator like Prometheus Pushgateway or an OpenTelemetry Collector.
2. **Scrape Availability vs. Database Health**: Prometheus `up{job="codenotes"}` proves only that the HTTP server is responsive and scrapable; active database availability must be verified via the `/api/health` endpoint.
3. **Structured Application Logging vs. Prometheus Metrics**: Structured JSON logs are emitted directly to stdout/stderr via a lightweight custom logger (`src/lib/logger.ts`). Pino is not installed, and no log ingestion pipeline is configured in the default local stack. Application logs are inspected in the terminal; Grafana visualizes Prometheus metrics only. Prometheus records aggregate counters and latency histograms with bounded labels, and never stores internal error messages.
4. **Optional Error Reporting**: Sentry error tracking is completely optional. If `SENTRY_DSN` is unset, the SDK initializes disabled with zero outbound network calls, and any captured exceptions resolve as safe no-ops.
5. **Distributed Log Correlation & Tracing**: Every inbound generation request receives or generates a correlation ID. The Node.js client sanitizes this to `^[a-zA-Z0-9_\-\.]{1,64}$` (`ai_client_request_id_normalized`) and transmits it via `X-Request-ID`. FastAPI validates the header in `RequestIdMiddleware`, logs all events with this ID, and echoes it in response headers. To trace a specific generation across Node.js and FastAPI logs, grep for the correlation ID:
   ```bash
   # Search Node.js and Inngest logs
   grep "c8b3e51b-5903-4862-b80e-31ac0b7dec51" app.log
   # Search FastAPI service logs
   grep "c8b3e51b-5903-4862-b80e-31ac0b7dec51" fastapi.log
   ```
6. **Authentication & Secret Fail-Closed Safeguards**: If `FASTAPI_SERVICE_SECRET` is unset, blank, or retains default placeholder text (`change_me_to_a_secure_random_string` / `your_fastapi_service_secret_here`), both Node.js and FastAPI fail closed immediately with a non-retryable `CONFIG_ERROR` / HTTP 503, preventing unauthenticated access or accidental unencrypted transmissions.
7. **Transport Security**: The Node.js client permits plain HTTP only when connecting to loopback targets (`localhost`, `127.0.0.1`, `::1`). Any remote non-local destination configured in `FASTAPI_SERVICE_URL` MUST use `https:` to protect service credentials in transit.
8. **Single-Secret Rotation & In-Flight Interruption**: Authentication relies on a single shared `FASTAPI_SERVICE_SECRET`. Token mismatches return HTTP 401, mapped in Node.js to `CONFIG_ERROR` and handled in Inngest as a `NonRetriableError` (no automatic retries). Secret rotations must be conducted during a scheduled maintenance window when no generation jobs are running to avoid terminating in-flight jobs. Dual-secret rotation is tracked as a future enhancement.
9. **Timeout Hierarchy**: Outbound Gemini inference timeout is 75s (`GEMINI_TIMEOUT_MS=75000`), the Node.js client abort timer is 85s (`DEFAULT_AI_TIMEOUT_MS=85000`), and the Vercel serverless function `maxDuration` is 90s. With Fluid Compute enabled, 90s is within Vercel's limits (Hobby maximum 300s, Pro/Enterprise maximum 800s; if Fluid Compute is disabled, Hobby is capped at 60s). Operators must verify Fluid Compute configuration in the Vercel dashboard prior to deployment. This staged hierarchy guarantees that internal application layers return clean structured errors before higher-level infrastructure proxies terminate the connection.
10. **Vercel Preview Deployment Protection**: When calling a Vercel-protected FastAPI Preview deployment, Next.js transmits the platform bypass token in the `x-vercel-protection-bypass` header (`FASTAPI_VERCEL_PROTECTION_BYPASS`) while continuing to authenticate service requests with the internal Bearer token (`FASTAPI_SERVICE_SECRET`). If `FASTAPI_VERCEL_PROTECTION_BYPASS` is omitted in protected preview environments, the client fails closed with a non-retryable `CONFIG_ERROR`. Neither secret is logged.
