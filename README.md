# CodeNotes AI

CodeNotes is an AI-powered technical study-notes application that transforms YouTube programming tutorials into structured, syntax-highlighted study notes. A user submits a YouTube URL; the system validates the input, authenticates via Supabase Auth, registers a durable idempotency reservation in PostgreSQL, and dispatches a background event to Inngest.

Inngest durable steps fetch the video transcript using a dual-provider strategy (Supadata API primary with `youtube-transcript` fallback) and shared PostgreSQL transcript caching, dispatches to a dedicated FastAPI AI Generator microservice invoking Google Gemini 2.5 Flash with structured schema enforcement, and atomically persists the study notes to PostgreSQL under Row Level Security (RLS) user isolation. The frontend provides live status polling and a keyset-paginated library with full search and sorting.

---

## Key Highlights & Architecture

- **Durable Serverless Execution**: Eliminates the operational overhead of persistent worker VMs, Redis, or BullMQ by utilizing Inngest serverless step functions.
- **Distributed Idempotency & Processing Leases**: Guarantees zero duplicate note writes and safe retries across network drops and concurrent requests via PostgreSQL `generation_idempotency` records with 15-minute leases.
- **Multi-Tenant PostgreSQL Row Level Security (RLS)**: Enforces complete user isolation directly at the database layer via `withUserTransaction` and transaction-local JWT claims (`SET LOCAL "request.jwt.claim.sub"`).
- **Dual-Provider Transcript Strategy & Shared Caching**: Reuses public transcripts across users in `youtube_transcripts` while keeping generated notes strictly isolated. Falls back cleanly from Supadata to YouTube scraping.
- **Dedicated Stateless AI Microservice**: Offloads Gemini inference and response validation to a separate Python FastAPI service deployed with sub-second health checks and Bearer token security.
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
| **AI Generator Microservice** | FastAPI, Python 3.13, `uv`, Google Gemini 2.5 Flash (`google-genai`), Pydantic v2 |
| **Transcripts** | Supadata API, `youtube-transcript`, shared PostgreSQL cache (`youtube_transcripts`) |
| **Observability** | Prometheus (`prom-client`), Grafana, `@sentry/nextjs`, structured JSON logging |
| **Testing** | Vitest, Playwright, Pytest, Ruff, Docker Compose |

---

## Project Documentation

Detailed technical documentation is available in the `docs/` and `services/` directories:

- 📖 **[Architecture Guide](docs/architecture.md)**: Deep dive into synchronous ingestion vs. durable execution, Mermaid architecture and sequence diagrams, database schema, RLS policies, distributed idempotency, error classification, and reconciliation.
- 🚀 **[FastAPI Production Runbook](docs/fastapi-production-runbook.md)**: Authoritative production deployment, Vercel configuration, Inngest sync, end-to-end smoke verification, log correlation, troubleshooting, and rollback procedures.
- 🛠️ **[Development & Testing Guide](docs/development.md)**: Prerequisites, local setup instructions across Node.js and Python/uv, environment variables reference, migrations, and running the test suites.
- ⚡ **[AI Generator Service README](services/ai-generator/README.md)**: Standalone Python microservice architecture, API schemas, error codes, client lifecycle, and local `uv` commands.
- 📊 **[Observability & Monitoring Guide](docs/observability.md)**: Prometheus metrics reference, alerting rules, Grafana dashboard panels, process-local scraping limitations in serverless, health checks, distributed tracing, and Sentry PII sanitization.

---

## Local Development Setup

### 1. Prerequisites
- **Node.js**: `v20.x` or higher
- **npm**: `v10.x` or higher
- **Python**: `3.13` (minimum 3.12, pinned via `services/ai-generator/.python-version`)
- **uv**: `v0.13.x` or higher (recommended for Python package management; or standard `venv` + `pip`)
- **PostgreSQL**: `16.x` (local instance or Supabase)
- **Docker Compose**: Required for running the Prometheus/Grafana stack and RLS test containers

### 2. Install Dependencies
```bash
# Node.js dependencies (use --legacy-peer-deps due to Vitest 5 / @types/node peer resolution):
npm install --legacy-peer-deps

# Python dependencies (locked environment via uv):
uv sync --project services/ai-generator
```

### 3. Environment Configuration
Copy `.env.example` to `.env.local` in the root:
```bash
cp .env.example .env.local
```
Set your database, Supabase, and FastAPI configuration in `.env.local`:
```env
DATABASE_URL=postgresql://postgres:postgrespassword@localhost:5432/codenotes
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
FASTAPI_SERVICE_URL=http://127.0.0.1:8000
FASTAPI_SERVICE_SECRET=your-fastapi-service-secret
# FASTAPI_VERCEL_PROTECTION_BYPASS=your-optional-preview-bypass-key
SUPADATA_API_KEY=your-optional-supadata-key
```

Configure `services/ai-generator/.env` for the Python microservice:
```bash
cd services/ai-generator
cp .env.example .env
# Set GEMINI_API_KEY and FASTAPI_SERVICE_SECRET (matching .env.local)
cd ../..
```

### 4. Run Database Migrations
Apply the atomic schema migration:
```bash
npm run db:migrate
```

> [!NOTE]
> Database migrations acquire a transaction-scoped PostgreSQL advisory lock (`7892348912734912`) to serialize concurrent migration runs safely, and abort if unowned legacy records are detected. Migrations are executed manually and do not run automatically during Vercel builds. See [docs/development.md](docs/development.md) for details.

### 5. Start Development Servers
In separate terminal sessions:

```bash
# Terminal 1: Next.js Web App (Turbopack)
npm run dev

# Terminal 2: Inngest Local Dev Server
npm run inngest:dev

# Terminal 3: FastAPI AI Generator Microservice (using uv)
uv run --project services/ai-generator uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Terminal 4 (Optional): Prometheus & Grafana Monitoring Stack
docker compose -f docker-compose.prometheus.yml up -d
```

- **Next.js Web App**: [http://localhost:3000](http://localhost:3000)
- **Inngest Dashboard**: [http://localhost:8288](http://localhost:8288)
- **FastAPI AI Service**: [http://localhost:8000/health](http://localhost:8000/health)
- **Prometheus**: [http://localhost:9090](http://localhost:9090)
- **Grafana**: [http://localhost:3001](http://localhost:3001) (`admin` / `admin`)

---

## Quality & Testing Gates

CodeNotes enforces automated quality checks covering the full testing pyramid:

```bash
# 1. Run all Node.js unit and integration tests (Vitest)
npm test

# 2. Run real loopback cross-process FastAPI boundary verification
npm run test:fastapi-boundary

# 3. Run Python unit and integration tests (Pytest via uv)
uv run --project services/ai-generator pytest services/ai-generator/tests -v

# 4. Check Python linting and formatting (Ruff)
uv run --project services/ai-generator ruff check services/ai-generator
uv run --project services/ai-generator ruff format --check services/ai-generator

# 5. Check Python lockfile consistency (uv)
uv lock --check --project services/ai-generator

# 6. Run PostgreSQL Row Level Security (RLS) integration tests
# (Requires TEST_DATABASE_URL pointing to isolated local 'codenotes_test' database)
npm run test:integration:rls

# 7. Validate Prometheus config, alert rules, and Grafana dashboard queries
npm run validate:observability

# 8. Run deterministic Playwright end-to-end tests
npm run test:e2e

# 9. Linting and TypeScript type checking
npm run lint
npx tsc --noEmit

# 10. Production Next.js build compilation
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
> - Query latency is recorded in Prometheus metrics (`http_request_duration_seconds`), and failures are emitted with structured error fields to stderr via JSON logs (`logger.error`).

---

## Operational Notes & Boundaries

1. **Process-Local Prometheus Metrics**: The in-memory Prometheus registry in `/api/metrics` reflects metrics for the local Node.js process. In distributed or serverless multi-instance deployments (such as Vercel), scraping process-local memory does not provide global aggregation without an external aggregator like Prometheus Pushgateway or an OpenTelemetry Collector.
2. **Scrape Availability vs. Database Health**: Prometheus `up{job="codenotes"}` proves only that the HTTP server is responsive and scrapable; active database availability must be verified via the `/api/health` endpoint.
3. **Structured Application Logging vs. Prometheus Metrics**: Structured JSON logs are emitted directly to stdout/stderr via a lightweight custom logger (`src/lib/logger.ts`). Pino is not installed, and no log ingestion pipeline is configured in the default local stack. Application logs are inspected in the terminal; Grafana visualizes Prometheus metrics only.
4. **Optional Error Reporting**: Sentry error tracking is completely optional. If `SENTRY_DSN` is unset, the SDK initializes disabled with zero outbound network calls, and any captured exceptions resolve as safe no-ops.
