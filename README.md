# CodeNotes

CodeNotes is an AI-powered application that converts YouTube programming tutorials into structured technical study notes. A user pastes a YouTube URL; the request is validated, authenticated via Supabase Auth, recorded as durable idempotency state in PostgreSQL, and dispatched as a durable serverless event to Inngest. Inngest steps reliably fetch video transcripts and metadata, invoke Google Gemini 2.5 Flash with schema enforcement, and atomically commit the study notes to PostgreSQL with Row Level Security (RLS) enforcement. The frontend seamlessly tracks generation progress via TanStack Query status polling.

---

## Features

- **Durable Serverless AI Generation**: Decouples HTTP ingestion from AI pipeline latency via Inngest serverless step execution without requiring persistent worker VMs or Redis instances.
- **At-Least-Once Processing with Idempotent Persistence**: Durable PostgreSQL idempotency records ensure zero duplicate note writes even across function retries or network partitions.
- **Supabase Authentication & Multi-Tenant RLS**: Complete user isolation enforced at the PostgreSQL database level via `withUserTransaction` and transaction-local JWT claims.
- **Modern Notes Library**: Keyset cursor pagination, search filtering, sorting, and responsive grid/list views powered by TanStack Query and Zustand.
- **Resilient AI Pipeline**: Parallel transcript & title fetching with automatic fallback to Gemini direct-video analysis when captions are disabled.
- **Truthful Status UX**: Live status transitions (`pending` → `processing` → `completed` / `failed`) without artificial progress bars.
- **Observability**: Structured JSON logging with request IDs and Prometheus metrics for HTTP requests and generation duration.

---

## Architecture

```text
Browser
  │
  ├── 1. POST /api/generate { url } (Idempotency-Key)
  │      └── requireUser() → validate → write DB 'pending' → inngest.send() → return 202 Accepted
  │
  ├── 2. Polling: GET /api/generate/status?key=... (TanStack Query every 1.5s)
  │
Inngest Serverless Execution Engine (/api/inngest)
  │
  ▼
Durable Function: "generate-notes"
  │
  ├── Step 1: claim-generation-processing
  │           └── Check DB status, validate payload, claim 5-minute lease (status = 'processing')
  ├── Step 2: fetch-transcript-and-title [OUTSIDE DB TRANSACTION]
  │           └── fetchTranscript (timeout 15s) + extractVideoTitle (timeout 4s)
  ├── Step 3: generate-ai-notes [OUTSIDE DB TRANSACTION]
  │           └── Gemini 2.5 Flash inference with fallback to direct video (timeout 75s)
  ├── Step 4: persist-notes [INSIDE withUserTransaction(userId)]
  │           ├── SET LOCAL "request.jwt.claim.sub" = userId
  │           ├── SET LOCAL ROLE authenticated
  │           ├── INSERT INTO notes (...)
  │           └── UPDATE generation_idempotency SET status = 'completed', note_id = ...
  └── onFailure: On unrecoverable error or max retries: update DB status = 'failed' with error code
```

---

## Distributed Idempotency & Failure Guarantees

1. **Authoritative Source of Truth**: PostgreSQL `generation_idempotency` table `(user_id, key)` is the ultimate source of truth for job lifecycle state.
2. **Deterministic Event Ingestion**: Inngest event IDs use deterministic identifiers (`gen-${userId}-${key}`) preventing duplicate event ingestion.
3. **Processing Lease Invariant**: Concurrent or re-delivered function executions verify the active lease (`lease_until`) and avoid repeating expensive transcript or AI operations.
4. **Crash-Safe Reconciliation**: If `inngest.send` fails due to a network glitch, the durable `pending` row is retained in PostgreSQL. An Inngest cron job (`*/5 * * * *`) scans stale pending/processing records and safely re-dispatches them.
5. **Database Transaction Boundary**: Long-running transcript and Gemini operations execute entirely outside database transactions; PostgreSQL connection pool clients are checked out only during the final atomic write (< 20ms).

---

## API Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/generate` | Dispatch a new note generation job (authenticated, returns 202 Accepted or 200 cached) |
| `GET` | `/api/generate/status` | Poll status of an in-flight generation (`pending`, `processing`, `completed`, `failed`) |
| `GET/POST/PUT` | `/api/inngest` | Inngest serve handler for serverless step execution and cron schedules |
| `GET` | `/api/notes` | List saved notes with keyset cursor pagination, search, and sorting |
| `GET` | `/api/notes/[id]` | Retrieve a single note by UUID (authenticated, RLS-scoped) |
| `DELETE` | `/api/notes/[id]` | Delete a note by UUID (authenticated, RLS-scoped) |
| `GET` | `/api/health` | Health check — probes database with `SELECT 1` |
| `GET` | `/api/metrics` | Prometheus metrics (HTTP + generation metrics) |

---

## Tech Stack

- **Framework**: Next.js 16.3 (App Router), React 19, TypeScript 5
- **Durable Execution & Background Jobs**: Inngest (`inngest`, `inngest/next`)
- **Database & Auth**: PostgreSQL (Supabase), Row Level Security (RLS), raw `pg.Pool`
- **State Management**: TanStack Query v5, Zustand v5
- **Validation**: React Hook Form, Zod
- **AI & Video Processing**: Google Gemini 2.5 Flash (`@google/generative-ai`), `youtube-transcript`
- **Observability**: Prometheus (`prom-client`), Structured JSON logging

---

## Local Development Setup

### 1. Prerequisites
- Node.js 20+
- PostgreSQL database (local or Supabase)
- Google Gemini API key

### 2. Environment Configuration
Copy `.env.example` to `.env.local` and set:
```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/codenotes
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
GEMINI_API_KEY=your-gemini-api-key
```

### 3. Run Migrations
```bash
npm run db:migrate
```

### 4. Start Next.js App and Inngest Dev Server
In terminal 1 (Next.js App):
```bash
npm run dev
```

In terminal 2 (Inngest Local Dev Server):
```bash
npm run inngest:dev
```
The Inngest Dev Server will be available at [http://localhost:8288](http://localhost:8288) to inspect function runs, triggers, and step logs.

---

## Quality & Testing

Run all quality gates:

```bash
# Run unit & integration test suites
npm test

# Run linter
npm run lint

# Run TypeScript type check
npx tsc --noEmit

# Production build
npm run build
```
