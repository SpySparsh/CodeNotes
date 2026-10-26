# CodeNotes Development & Testing Guide

This guide covers local environment setup, configuration, database migrations, running the development services across Node.js and Python, and executing the complete automated test suites.

---

## 1. Prerequisites

- **Node.js**: `v20.x` or higher (LTS recommended).
- **npm**: `v10.x` or higher.
- **Python**: `3.13` (minimum 3.12, pinned to `3.13` via `services/ai-generator/.python-version`).
- **uv**: `v0.13.x` or higher (strongly recommended for Python dependency management and lockfile consistency; alternative: Python `venv` + `pip`).
- **PostgreSQL**: `16.x` (local instance or Supabase project).
- **Docker & Docker Compose**: Required for running the Prometheus/Grafana monitoring stack and for local PostgreSQL test containers.

---

## 2. Environment Configuration

The CodeNotes monorepo contains two distinct runtime environments:
1. **Next.js Web Application & Inngest**: Configured via `.env.local` in the repository root.
2. **FastAPI AI Generator Service**: Configured via `.env` in `services/ai-generator/`.

### A. CodeNotes Application Environment (`.env.local`)

Copy the template from the repository root:
```bash
cp .env.example .env.local
```

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | Primary PostgreSQL connection string | `postgresql://postgres:postgrespassword@localhost:5432/codenotes` |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project API URL (client & server auth) | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Supabase anonymous API key | `your-supabase-anon-key` |
| `FASTAPI_SERVICE_URL` | **Yes** | Base URL of the FastAPI AI generator service. In local dev: `http://127.0.0.1:8000`. Non-local / prod **must use `https://`**. | `http://127.0.0.1:8000` |
| `FASTAPI_SERVICE_SECRET` | **Yes** | Shared Bearer secret token for authenticating calls to FastAPI. Must match `services/ai-generator/.env`. | `your-secure-random-secret-token` |
| `FASTAPI_VERCEL_PROTECTION_BYPASS` | Preview Only | Platform secret to bypass Vercel Deployment Protection on FastAPI Preview deployments. Leave unset in local and production. | `your-vercel-bypass-secret` |
| `SUPADATA_API_KEY` | Optional | Supadata API key for primary transcript retrieval (falls back to scraper if unset or failed) | `your-supadata-key` |
| `INNGEST_EVENT_KEY` | Optional | Inngest event sending key (for cloud event dispatch; not needed for local dev server) | `mock-event-key` |
| `INNGEST_SIGNING_KEY` | Optional | Inngest webhook signature verification key | `mock-signing-key` |
| `METRICS_SECRET` | Optional locally, **Required** in Preview/Prod | Secret Bearer token for authenticating Prometheus scrapes to `/api/metrics`. In local dev, leave unset for unauthenticated scraping. In Preview/Prod, missing secret fails closed with HTTP 503. | `your-metrics-secret` |
| `TEST_DATABASE_URL` | For RLS tests | Dedicated, isolated local PostgreSQL database used strictly for RLS migration & policy tests (must point to `codenotes_test` on `localhost`) | `postgresql://postgres:postgrespassword@localhost:5432/codenotes_test` |
| `SENTRY_DSN` | Optional | Server runtime Sentry DSN (safe to leave unset; Sentry initializes disabled with 0 outbound requests) | `https://examplePublicKey@o0.ingest.sentry.io/0` |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | Client/browser Sentry DSN (safe to leave unset) | `https://examplePublicKey@o0.ingest.sentry.io/0` |
| `DATABASE_CA_CERT` | Optional | PostgreSQL Root CA Certificate (PEM string format) for SSL connections | `-----BEGIN CERTIFICATE-----...` |
| `E2E_USER_EMAIL` | Optional | Email for Playwright authenticated live smoke tests (mock auth used by default) | `test-user@example.com` |
| `E2E_USER_PASSWORD` | Optional | Password for Playwright authenticated live smoke tests | `test-password-123` |

### B. FastAPI Microservice Environment (`services/ai-generator/.env`)

Copy the template in `services/ai-generator`:
```bash
cd services/ai-generator
cp .env.example .env
cd ../..
```

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `FASTAPI_SERVICE_SECRET` | **Yes** | Shared Bearer token. Must match `FASTAPI_SERVICE_SECRET` in `.env.local`. | `your-secure-random-secret-token` |
| `GEMINI_API_KEY` | **Yes** | Google Gemini API key from [Google AI Studio](https://aistudio.google.com/). | `AIza...` |
| `GEMINI_MODEL` | No | Model name for note generation. Default: `gemini-2.5-flash`. | `gemini-2.5-flash` |
| `GEMINI_TIMEOUT_MS` | No | Outbound Gemini API timeout in milliseconds. Default: `75000` (75s). | `75000` |
| `HOST` | No | Bind host. Default: `0.0.0.0`. | `0.0.0.0` |
| `PORT` | No | Bind port. Default: `8000`. | `8000` |
| `ENVIRONMENT` | No | Runtime environment name. | `development` |

> [!CAUTION]
> Never commit `.env`, `.env.local`, or any actual credentials to git. The repository enforces `.gitignore` patterns for all private environment files.

---

## 3. Database Setup & Migrations

The database schema is defined as an idempotent SQL migration script in [`scripts/migrate.js`](../scripts/migrate.js).

To apply the schema to the database pointed to by `DATABASE_URL`:

```bash
npm run db:migrate
```

### Migration Safeguards & Concurrency Controls
1. **Transaction-Scoped Advisory Lock**:
   Immediately after opening an atomic transaction (`BEGIN`), the migration acquires PostgreSQL advisory lock key `7892348912734912`:
   ```sql
   SELECT pg_advisory_xact_lock(7892348912734912::bigint);
   ```
   This serializes concurrent migration processes, preventing race conditions or deadlock between multiple migration runners. The lock is released automatically by PostgreSQL when the transaction commits or rolls back.
2. **Phase 1 Legacy Data Safeguard**:
   Before enforcing `NOT NULL` on `user_id` columns in `notes` and `generation_idempotency`, the migration asserts that zero unowned legacy records exist. If unowned rows are detected, the migration immediately aborts with an exception to prevent silent data loss or unintended schema breakage.
3. **Manual Execution Requirement**:
   **Migrations do NOT run automatically during `npm run build` or the Vercel deployment pipeline.** When deploying database schema changes, operators must execute `npm run db:migrate` manually against the target environment database.

This creates or updates the required tables:
- `notes`: User study notes protected by PostgreSQL RLS.
- `generation_idempotency`: Tracks asynchronous note generation job lifecycles and processing leases.
- `youtube_transcripts`: Public cache of fetched YouTube video transcripts.
- `rate_limit_buckets`: Per-user token-bucket rate limiter states.

### (Optional) Database Seeding
To populate sample notes for local exploration:

```bash
npm run db:seed
```

---

## 4. Running the Development Environment

Running CodeNotes locally requires three processes (or four with optional monitoring):

### Terminal 1: Next.js Web Application
```bash
npm run dev
```
Starts Next.js with Turbopack at [http://localhost:3000](http://localhost:3000).

### Terminal 2: Inngest Local Dev Server
```bash
npm run inngest:dev
```
Starts the local Inngest development runtime at [http://localhost:8288](http://localhost:8288). It automatically connects to the Next.js app's `/api/inngest` endpoint, enabling live inspection of durable step runs, event triggers, retries, and step logs.

### Terminal 3: FastAPI AI Generator Microservice
Using `uv` (recommended):
```bash
uv run --project services/ai-generator uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
Or using an activated virtual environment:
```bash
cd services/ai-generator
# Windows:
.\.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```
- Health probe: [http://localhost:8000/health](http://localhost:8000/health)

### Terminal 4 (Optional): Local Observability Stack
```bash
docker compose -f docker-compose.prometheus.yml up -d
```
Starts:
- **Prometheus** at [http://localhost:9090](http://localhost:9090) (scraping `http://host.docker.internal:3000/api/metrics`).
- **Grafana** at [http://localhost:3001](http://localhost:3001) (`admin` / `admin`) with the pre-provisioned CodeNotes dashboard.

---

## 5. Automated Test Suites & Quality Gates

CodeNotes enforces automated quality checks covering the full testing pyramid:

### 1. Node.js Unit & Integration Tests (Vitest)
Executes all unit tests, route handlers, error classifiers, Inngest durable step retries, Prometheus metrics, and Sentry sanitizer tests:
```bash
npm test
```

### 2. Cross-Process FastAPI Boundary Verification
Starts a local mock server and executes end-to-end loopback HTTP assertions against real network endpoints without calling live Gemini APIs (zero API cost):
```bash
npm run test:fastapi-boundary
```
Asserts `/health` (200), unauthenticated rejection (401), schema validation (422), camelCase note deserialization, `X-Request-ID` correlation preservation, upstream rate-limit mapping (429), and timeout enforcement.

### 3. Python Service Test Suite (Pytest)
Executes 60+ unit and integration tests covering prompt generation, Pydantic schema validation, error mapping, and authentication against mocked Gemini SDK responses:
```bash
# Using uv directly:
uv run --project services/ai-generator pytest services/ai-generator/tests -v

# Or from within services/ai-generator with active venv:
cd services/ai-generator && pytest && cd ../..
```

### 4. Python Linting & Formatting (Ruff)
Checks Python style, import sorting, and syntax formatting:
```bash
uv run --project services/ai-generator ruff check services/ai-generator
uv run --project services/ai-generator ruff format --check services/ai-generator
```

### 5. Python Dependency & Lockfile Consistency (uv)
Validates that `services/ai-generator/pyproject.toml` and `uv.lock` are perfectly synchronized:
```bash
uv lock --check --project services/ai-generator
```

### 6. PostgreSQL Row Level Security (RLS) Integration Tests
Validates real multi-tenant PostgreSQL security policies using direct SQL transactions:
```bash
npm run test:integration:rls
```
*Requires `TEST_DATABASE_URL` pointing strictly to local `codenotes_test` on `localhost`.*

### 7. Observability Configuration Validation
Statically validates the Grafana dashboard JSON, verifies panel queries against the approved metrics catalog, and verifies alert rules and Docker Compose bind mounts:
```bash
npm run validate:observability
```

### 8. Playwright Deterministic End-to-End Tests
Executes headless browser tests covering authentication, generation submission, async polling transitions, and multi-user isolation:
```bash
npm run test:e2e
```

### 9. TypeScript Compilation & ESLint
```bash
# Run ESLint across src/
npm run lint

# Strict TypeScript type check
npx tsc --noEmit

# Production Next.js build compilation
npm run build
```

---

## 6. Safe Local Smoke Testing (Zero Gemini Billing)

You can verify the entire local pipeline without calling Google Gemini or consuming API quota:

1. **Verify FastAPI Health**:
   ```bash
   curl -i http://localhost:8000/health
   # Expected: HTTP/1.1 200 OK, {"status": "healthy"}, x-request-id present
   ```
2. **Verify Bearer Authentication Rejection**:
   ```bash
   curl -i -X POST http://localhost:8000/api/v1/generate \
     -H "Content-Type: application/json" \
     -d '{"transcript": "test", "videoTitle": "test"}'
   # Expected: HTTP/1.1 401 Unauthorized, {"error": {"code": "UNAUTHORIZED"}}
   ```
3. **Run Boundary Integration Test Suite**:
   ```bash
   npm run test:fastapi-boundary
   ```
   This automatically verifies the Node.js client (`src/lib/ai-client.ts`) communicating with a loopback server, asserting header propagation, authentication, and error translation.

For production deployment instructions, troubleshooting runbooks, and rollback procedures, see the [FastAPI Production Runbook](fastapi-production-runbook.md).
