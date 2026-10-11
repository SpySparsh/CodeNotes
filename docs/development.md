# CodeNotes Development & Testing Guide

This guide covers local environment setup, configuration, database migrations, running the development services, and executing the complete automated test suites.

---

## 1. Prerequisites

- **Node.js**: `v20.x` or higher (LTS recommended).
- **npm**: `v10.x` or higher.
- **PostgreSQL**: `16.x` (local instance or Supabase project).
- **Docker & Docker Compose**: Required for running the Prometheus/Grafana monitoring stack and for local PostgreSQL test containers.

---

## 2. Environment Configuration

Copy the example environment template to `.env.local`:

```bash
cp .env.example .env.local
```

### Environment Variables Reference

| Variable | Required | Description | Example / Default |
| :--- | :---: | :--- | :--- |
| `DATABASE_URL` | **Yes** | Connection string for primary PostgreSQL database | `postgresql://postgres:postgrespassword@localhost:5432/codenotes` |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project API URL (used for client & server auth) | `http://127.0.0.1:54321` or `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Supabase public anonymous API key | `mock-anon-key` or your project anon key |
| `GEMINI_API_KEY` | **Yes** | Google Gemini API key for structured study-notes generation | Get from [Google AI Studio](https://aistudio.google.com/) |
| `SUPADATA_API_KEY` | Optional | Supadata API key for primary transcript retrieval (falls back to scraper if unset or failed) | Get from [Supadata.ai](https://supadata.ai/) |
| `INNGEST_EVENT_KEY` | Optional | Inngest event sending key (for cloud event dispatch; not needed for local dev server) | `mock-event-key` |
| `INNGEST_SIGNING_KEY` | Optional | Inngest webhook signature verification key | `mock-signing-key` |
| `TEST_DATABASE_URL` | For RLS tests | Dedicated, isolated local PostgreSQL database used strictly for RLS migration & policy tests | `postgresql://postgres:postgrespassword@localhost:5432/codenotes_test` |
| `SENTRY_DSN` | Optional | Server runtime Sentry DSN (safe to leave unset; Sentry initializes disabled with 0 outbound requests) | `https://examplePublicKey@o0.ingest.sentry.io/0` |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional | Client/browser Sentry DSN (safe to leave unset) | `https://examplePublicKey@o0.ingest.sentry.io/0` |
| `SENTRY_AUTH_TOKEN` | Optional | Sentry authentication token for sourcemap uploads during production build | `sntrys_...` |
| `SENTRY_ORG` | Optional | Sentry organization identifier for sourcemap uploads | `my-org` |
| `SENTRY_PROJECT` | Optional | Sentry project identifier for sourcemap uploads | `codenotes` |
| `DATABASE_CA_CERT` | Optional | PostgreSQL Root CA Certificate (PEM string format) for SSL connections | `-----BEGIN CERTIFICATE-----...` |
| `E2E_USER_EMAIL` | Optional | Email for Playwright authenticated live smoke tests (mock auth used by default) | `test-user@example.com` |
| `E2E_USER_PASSWORD` | Optional | Password for Playwright authenticated live smoke tests | `test-password-123` |

> [!CAUTION]
> Never commit `.env`, `.env.local`, or any actual credentials to git. The repository enforces `.gitignore` patterns for all private environment files.

---

## 3. Database Setup & Migrations

The database schema is defined as an idempotent SQL migration script in [`scripts/migrate.js`](file:///d:/unstuckstudy/scripts/migrate.js).

To apply the schema to the database pointed to by `DATABASE_URL`:

```bash
npm run db:migrate
```

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

CodeNotes requires two processes in local development: the Next.js development server and the Inngest local development server.

### Terminal 1: Next.js Web Application
```bash
npm run dev
```
Starts the Next.js server with Turbopack at [http://localhost:3000](http://localhost:3000).

### Terminal 2: Inngest Local Dev Server
```bash
npm run inngest:dev
```
Starts the local Inngest development runtime at [http://localhost:8288](http://localhost:8288). It automatically connects to the Next.js app's `/api/inngest` endpoint, enabling live inspection of durable step runs, event triggers, retries, and step logs.

### Terminal 3 (Optional): Local Observability Stack
```bash
docker compose -f docker-compose.prometheus.yml up -d
```
Starts:
- **Prometheus** at [http://localhost:9090](http://localhost:9090) (scraping `http://host.docker.internal:3000/api/metrics`).
- **Grafana** at [http://localhost:3001](http://localhost:3001) (default login: `admin` / `admin`) with the pre-provisioned CodeNotes dashboard.

---

### Manual Verification & Smoke Testing

To manually verify generation, transcript caching, and idempotency replay in a live or local environment:

1. **Initial Generation (Cache Miss)**:
   Submit a YouTube URL from the web UI (`/`). The client generates a fresh `Idempotency-Key` UUID. Background execution fetches the transcript (calling Supadata or scraper), runs Gemini 2.5 inference, and persists the note.
2. **Transcript Caching vs. Note Deduplication**:
   Submitting the same video URL again from the UI generates a *new* `Idempotency-Key` UUID. The system reuses the cached transcript from `youtube_transcripts` (avoiding external caption calls), but runs Gemini inference again and creates an independent note. Separate UUIDs do not deduplicate notes.
3. **Idempotency Replay**:
   To test idempotency replay (`200 OK` with `cached: true`):
   - **Replay of a UI submission**: Re-send the request with the exact same `Idempotency-Key: <original-uuid>` header used by the UI.
   - **Deterministic hash replay**: Submit `POST /api/generate` with `{ "url": "..." }` and *omit* the `Idempotency-Key` header entirely across both initial and replay requests. The server derives `sha256(userId:videoId)`. Replaying that headerless request returns the completed note without re-running Gemini. A request without the header does not match a UUID-based UI job.

---

## 5. Automated Test Suites

CodeNotes maintains a comprehensive testing pyramid across unit, integration, RLS policy, observability, and end-to-end suites.

### A. Unit & Integration Tests (Vitest)
Executes all unit tests, route handlers, error classifiers, Inngest durable step retries, Prometheus metrics, and Sentry sanitizer tests:

```bash
npm test
```

### B. PostgreSQL Row Level Security (RLS) Integration Tests
Validates real multi-tenant PostgreSQL security policies using direct SQL transactions:

```bash
npm run test:integration:rls
```

#### Strict Safety Guardrails for RLS Testing:
The RLS test suite ([`tests/integration/rls.integration.test.ts`](file:///d:/unstuckstudy/tests/integration/rls.integration.test.ts)) contains an automated pre-flight security assertion:
1. `TEST_DATABASE_URL` **must** be set explicitly.
2. The hostname **must** resolve to `localhost`, `127.0.0.1`, or `::1`.
3. The database name **must** strictly be `codenotes_test`.
4. Remote, staging, or production databases (e.g. Supabase, AWS RDS, Neon) are unconditionally rejected to prevent accidental table truncation or policy overwrites.

### C. Observability Configuration Validation
Statically validates the Grafana dashboard JSON, verifies every panel query against the approved Prometheus metrics whitelist, and verifies alert rules and Docker Compose bind mounts:

```bash
npm run validate:observability
```

### D. Playwright Deterministic End-to-End Tests
Executes the headless browser testing suite covering user authentication, generation form submission, async status transitions, keyset pagination, and multi-user isolation:

```bash
npm run test:e2e
```

### E. Code Quality & Type Checks
```bash
# Run ESLint across src/
npm run lint

# Strict TypeScript compiler typecheck
npx tsc --noEmit

# Production Next.js build compilation
npm run build
```

---

## 6. Continuous Integration (CI)

All quality gates run automatically in GitHub Actions on every push and pull request targeting `main` ([`.github/workflows/ci.yml`](file:///d:/unstuckstudy/.github/workflows/ci.yml)):

```text
GitHub Actions Workflow:
  ├── 1. Setup Node.js 20 & install dependencies (npm ci --legacy-peer-deps)
  ├── 2. Spin up containerized PostgreSQL 16 service (codenotes_test)
  ├── 3. Unit & Integration tests (npm test)
  ├── 4. PostgreSQL RLS integration tests (npm run test:integration:rls)
  ├── 5. Promtool check config & rules (prom/prometheus:v2.54.1 container)
  ├── 6. Docker Compose validation (docker compose -f docker-compose.prometheus.yml config)
  ├── 7. ESLint (npm run lint)
  ├── 8. TypeScript typecheck (npx tsc --noEmit)
  ├── 9. Production Next.js build (npm run build)
  └── 10. Playwright Chromium deterministic E2E tests (npm run test:e2e)
```
