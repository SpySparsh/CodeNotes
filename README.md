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
                                                                    ├── Step 1: Claim 15-min lease
                                                                    ├── Step 2: Fetch transcript (Cache / Supadata / Scraper)
                                                                    ├── Step 3: Gemini 2.5 Flash inference
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

### 2. Environment Configuration
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
SUPADATA_API_KEY=your-optional-supadata-key
```

### 3. Run Database Migrations
Apply the idempotent schema migration:
```bash
npm run db:migrate
```

### 4. Start Development Servers
In separate terminal sessions:

```bash
# Terminal 1: Next.js Web App (Turbopack)
npm run dev

# Terminal 2: Inngest Local Dev Server
npm run inngest:dev

# Terminal 3 (Optional): Prometheus & Grafana Monitoring Stack
docker compose -f docker-compose.prometheus.yml up -d
```
- **App**: [http://localhost:3000](http://localhost:3000)
- **Inngest Dashboard**: [http://localhost:8288](http://localhost:8288)
- **Prometheus**: [http://localhost:9090](http://localhost:9090)
- **Grafana**: [http://localhost:3001](http://localhost:3001) (`admin` / `admin`)

---

## Quality & Testing Gates

CodeNotes enforces automated quality checks covering the full testing pyramid:

```bash
# 1. Run all unit, integration, and sanitizer tests (Vitest)
npm test

# 2. Run PostgreSQL Row Level Security (RLS) integration tests
# (Requires TEST_DATABASE_URL pointing to isolated local 'codenotes_test' database)
npm run test:integration:rls

# 3. Validate Prometheus config, alert rules, and Grafana dashboard queries
npm run validate:observability

# 4. Run deterministic Playwright end-to-end tests
npm run test:e2e

# 5. Linting and TypeScript type checking
npm run lint
npx tsc --noEmit

# 6. Production Next.js build compilation
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
| `GET` | `/api/health` | Active database liveness probe (`SELECT 1`) returning connection latency |
| `GET` | `/api/metrics` | Prometheus metrics endpoint exposing HTTP, pipeline, and AI inference telemetry |

---

## Operational Notes & Boundaries

1. **Process-Local Prometheus Metrics**: The in-memory Prometheus registry in `/api/metrics` reflects metrics for the local Node.js process. In distributed or serverless multi-instance deployments (such as Vercel), scraping process-local memory does not provide global aggregation without an external aggregator like Prometheus Pushgateway or an OpenTelemetry Collector.
2. **Scrape Availability vs. Database Health**: Prometheus `up{job="codenotes"}` proves only that the HTTP server is responsive and scrapable; active database availability must be verified via the `/api/health` endpoint.
3. **Optional Error Reporting**: Sentry error tracking is completely optional. If `SENTRY_DSN` is unset, the SDK initializes disabled with zero outbound network calls, and any captured exceptions resolve as safe no-ops.
