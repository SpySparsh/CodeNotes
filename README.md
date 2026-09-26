# CodeNotes

CodeNotes is an AI-powered tool that converts YouTube programming tutorials into structured technical study notes. A user pastes a YouTube URL; the application fetches the video transcript and metadata in parallel, sends them to Google Gemini 2.5 Flash with a schema-enforced prompt, and persists the generated notes — overview, key concepts, inline-code-annotated detailed notes, and quick tips — to a PostgreSQL database. If transcript extraction fails, Gemini processes the video URL directly as a fallback. The application is deployed on Vercel with a Supabase PostgreSQL backend.

---

## Features

- YouTube URL → structured study notes in a single request
- Parallel transcript and title fetching for reduced latency
- Gemini direct-video fallback when captions are unavailable
- Schema-enforced JSON output: overview, key concepts, detailed Markdown notes with inline code blocks and comparison tables, shorthands
- Saved notes library with retrieval and deletion
- Markdown and syntax-highlighted code rendering
- Idempotent generation via `Idempotency-Key` header
- Stale idempotency record recovery
- Transactional note persistence and idempotency completion
- Structured JSON logging with request/correlation IDs
- Prometheus metrics endpoint
- Health check endpoint with live database probe
- PostgreSQL TLS certificate verification in production

---

## Architecture

```
Browser
  │
  │  POST /api/generate  {url}
  ▼
Vercel / Next.js (Node.js runtime)
  │
  ├── transcript.ts ──► youtube-transcript pkg  ──► captions text
  │                 ──► noembed.com             ──► video title
  │                     (both run concurrently via Promise.all)
  │
  │   if transcript OK:
  ├── gemini.ts ─────► Gemini 2.5 Flash (transcript + title)
  │
  │   if transcript FAILS:
  ├── gemini.ts ─────► Gemini 2.5 Flash (video URL directly)
  │
  ├── db.ts ──────────► Supabase PostgreSQL
  │                     BEGIN
  │                       INSERT INTO notes
  │                       UPDATE generation_idempotency (if key present)
  │                     COMMIT
  │
  └── → { noteId }  →  Browser redirects to /notes/[id]
```

**Frontend** is a Next.js App Router application (React 19, Tailwind CSS v4). Pages are at `/` (URL input), `/library` (saved notes grid), and `/notes/[id]` (full note reader with Markdown and syntax highlighting).

**Backend** is a set of Next.js Route Handlers running on the Node.js runtime. All database access goes through a `pg.Pool` connection pool. There is no separate API server.

**AI** calls are synchronous within the request lifecycle. Generation is the dominant latency component; the application architecture is intentionally simple and synchronous.

**Database** is PostgreSQL hosted on Supabase. Two tables: `notes` (primary storage) and `generation_idempotency` (in-flight deduplication). Schema is managed by a plain Node.js migration script.

---

## Application Flow

1. Client submits a YouTube URL with a client-generated `Idempotency-Key` UUID.
2. `POST /api/generate` validates that a URL is present in the request body.
3. Idempotency check: attempt `INSERT INTO generation_idempotency ON CONFLICT DO NOTHING`.
   - If the key already exists and status is `completed`, the existing `note_id` is returned immediately — no Gemini call is made.
   - If status is `processing` and the record is younger than 120 seconds, a `409 Conflict` is returned.
   - If status is `processing` and the record is older than 120 seconds (stale), an atomic `UPDATE ... WHERE COALESCE(updated_at, created_at) < $cutoff` reclaims it.
4. Transcript fetch (`youtube-transcript`) and title fetch (`noembed.com`) run concurrently via `Promise.all`. Transcript fetch has a 15-second timeout; title fetch has a 4-second timeout.
5. If transcript extraction succeeds, `generateNotes(transcript, title)` is called.
6. If transcript extraction fails, `generateNotesFromVideoUrl(url, title)` is called — Gemini processes the YouTube URL directly. This path is slower.
7. Gemini 2.5 Flash returns a schema-validated JSON object. Both paths use a 75-second timeout.
8. A PostgreSQL transaction atomically inserts the note and updates the idempotency record to `completed`.
9. `{ success: true, noteId }` is returned; the client navigates to `/notes/[id]`.
10. If any step fails, the idempotency record is deleted so the client can retry.

---

## Tech Stack

### Frontend
| | |
|---|---|
| Framework | Next.js 16.3.3 (App Router) |
| UI library | React 19.2.4 |
| Styling | Tailwind CSS v4 |
| Markdown rendering | react-markdown 9, remark-gfm 4 |
| Syntax highlighting | react-syntax-highlighter 15 |
| Icons | lucide-react 0.475 |

### Backend
| | |
|---|---|
| Runtime | Node.js via Next.js Route Handlers |
| Language | TypeScript 5 |
| Database driver | pg 8.20 (connection pool) |

### AI
| | |
|---|---|
| Provider | Google Gemini |
| Model | gemini-2.5-flash |
| SDK | @google/generative-ai 0.24 |
| Output format | Schema-enforced JSON (`responseMimeType: application/json`) |

### Database
| | |
|---|---|
| Engine | PostgreSQL |
| Host | Supabase |

### Infrastructure
| | |
|---|---|
| Deployment | Vercel |
| Bundler (dev) | Next.js Turbopack |

### Testing / Quality
| | |
|---|---|
| Test framework | Vitest 5 |
| Linter | ESLint 9 with eslint-config-next |
| Type checker | TypeScript (`tsc --noEmit`) |

### Observability
| | |
|---|---|
| Logging | Custom structured JSON logger |
| Metrics | prom-client 15 (`/api/metrics`) |
| Local monitoring stack | Prometheus + Grafana via Docker Compose |

### CI/CD
| | |
|---|---|
| Platform | GitHub Actions |
| Trigger | Push / PR to `main` |
| Pipeline | test → lint → typecheck → build |

---

## Project Structure

```
.
├── .env.example                      # Environment variable template
├── .github/workflows/ci.yml          # GitHub Actions CI pipeline
├── docker-compose.prometheus.yml     # Local Prometheus + Grafana stack
├── next.config.mjs                   # Next.js / Turbopack configuration
├── prometheus/
│   ├── prometheus.yml                # Scrape config (targets localhost:3000)
│   └── rules/                        # Alerting rules
├── grafana/                          # Grafana provisioning (datasources, dashboards)
├── scripts/
│   ├── migrate.js                    # Schema migration (idempotent, runs in a transaction)
│   └── seed-from-json.js             # Optional local data seeding from JSON
├── tests/
│   ├── setup.ts
│   ├── generate.test.ts              # Full generation pipeline, idempotency, fallback
│   ├── health.test.ts
│   ├── metrics.test.ts
│   ├── notes.test.ts
│   ├── notes-id.test.ts
│   ├── transcript.test.ts            # URL validation, timeout, title fallback
│   └── db.test.ts                    # SSL config, pool settings
└── src/
    ├── app/
    │   ├── page.tsx                  # Landing page / URL input
    │   ├── library/page.tsx          # Saved notes grid
    │   ├── notes/[id]/page.tsx       # Full note reader
    │   └── api/
    │       ├── generate/route.ts     # Core generation pipeline
    │       ├── notes/route.ts        # GET /api/notes
    │       ├── notes/[id]/route.ts   # GET + DELETE /api/notes/[id]
    │       ├── health/route.ts       # GET /api/health
    │       └── metrics/route.ts      # GET /api/metrics (Prometheus)
    ├── components/
    │   ├── UrlInput.tsx              # URL form, client-side idempotency key generation
    │   ├── CodeBlock.tsx             # Syntax-highlighted code with copy
    │   ├── NoteCard.tsx              # Library card with optimistic delete
    │   ├── Navbar.tsx
    │   └── LoadingState.tsx
    └── lib/
        ├── db.ts                     # pg.Pool, SSL config, withTransaction helper
        ├── gemini.ts                 # generateNotes, generateNotesFromVideoUrl, timeout
        ├── transcript.ts             # fetchTranscript, extractVideoTitle, validateYouTubeUrl
        ├── logger.ts                 # Structured JSON logger
        ├── metrics.ts                # prom-client registry, counters, histograms
        └── request-context.ts        # Request ID extraction / generation
```

---

## API Reference

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/generate` | Generate notes from a YouTube URL |
| `GET` | `/api/notes` | List all saved notes (up to 200, newest first) |
| `GET` | `/api/notes/[id]` | Retrieve a single note by UUID |
| `DELETE` | `/api/notes/[id]` | Delete a note by UUID |
| `GET` | `/api/health` | Health check — probes database with `SELECT 1` |
| `GET` | `/api/metrics` | Prometheus metrics (text/plain exposition format) |

**`POST /api/generate`**

- Request body: `{ "url": "https://www.youtube.com/watch?v=..." }`
- Optional request header: `Idempotency-Key: <uuid>`
- On success: `200 { success: true, noteId: "<uuid>" }`
- If key is already `completed`: `200` with the original `noteId`, no generation performed
- If key is `processing` (< 120s old): `409 { success: false, error: "Generation already in progress" }`
- Missing URL: `400 { error: "YouTube URL is required" }`
- All responses include `x-request-id` header

**`GET /api/notes`**

Returns projected fields only (`id`, `video_id`, `video_title`, `thumbnail_url`, `overview`, `created_at`). Full note content is not included in the list response. Result is capped at 200 rows.

**`GET /api/health`**

- `200 { status: "healthy", database: "connected", timestamp }` when database responds
- `503 { status: "unhealthy", database: "disconnected", timestamp }` on database failure

---

## Database

### Tables

**`notes`** — primary storage for generated study notes.

```
id              UUID PRIMARY KEY
video_id        VARCHAR(255) NOT NULL      -- 11-char YouTube video ID
video_title     TEXT NOT NULL              -- fetched via noembed.com
video_url       TEXT NOT NULL              -- original URL submitted by user
thumbnail_url   TEXT                       -- YouTube CDN maxresdefault.jpg
overview        TEXT
key_concepts    TEXT[]
detailed_notes  TEXT                       -- Markdown with inline code and tables
shorthands      TEXT[]
created_at      TIMESTAMPTZ DEFAULT NOW()
```

Index: `idx_notes_created_at ON notes(created_at DESC)` — supports the library list query.

**`generation_idempotency`** — tracks in-flight and completed generation requests.

```
key         VARCHAR(64) PRIMARY KEY        -- client-supplied UUID
status      VARCHAR(20) NOT NULL           -- 'processing' | 'completed'
note_id     UUID REFERENCES notes(id) ON DELETE SET NULL
created_at  TIMESTAMPTZ DEFAULT NOW()
updated_at  TIMESTAMPTZ DEFAULT NOW()
```

Index: `idx_generation_idempotency_created_at ON generation_idempotency(created_at)` — supports stale record queries.

Note and idempotency completion are written inside a single PostgreSQL transaction, so a partial write is not possible.

### Migration

Schema migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and runs in a single transaction.

```bash
npm run db:migrate        # reads DATABASE_URL from .env.local
npm run db:seed           # optional: seed from local JSON file
```

The migration script (`scripts/migrate.js`) mirrors the SSL policy of `src/lib/db.ts`: no SSL in development, full TLS certificate verification in production.

---

## Reliability

### Timeouts

| Operation | Timeout | Mechanism |
|---|---|---|
| Transcript fetch | 15 s | `Promise.race` against a `setTimeout` rejection |
| Title fetch (noembed) | 4 s | `AbortSignal.timeout(4000)` on `fetch` |
| Gemini inference | 75 s | SDK-level `timeout` option |
| PostgreSQL query | 10 s | `query_timeout: 10000` on `pg.Pool` |
| PostgreSQL connection | 5 s | `connectionTimeoutMillis: 5000` on `pg.Pool` |

### Idempotency

The client generates a UUID per submission and sends it as `Idempotency-Key`. The server attempts `INSERT INTO generation_idempotency ON CONFLICT DO NOTHING`:

- Lock acquired (new key): generation proceeds normally.
- Key exists and `completed`: original `noteId` is returned without calling Gemini.
- Key exists and `processing` (fresh): `409` is returned.
- Key exists and `processing` (stale, > 120 s): an atomic conditional `UPDATE` attempts to reclaim the record. If another concurrent request wins the reclaim race, the losing request re-reads state and either replays the completed result or returns `409`.

On any generation failure, the idempotency record is deleted so the client can retry with the same or a new key.

### Transactions

Note insertion and idempotency update run inside a single PostgreSQL transaction via `withTransaction`. Both succeed or both roll back.

### Failure handling

- Transcript failures are caught and logged at `warn` level; generation falls back to Gemini direct-video processing automatically.
- All error responses return sanitized client messages — internal error details are logged server-side but never returned to the client.
- Three error messages are surfaced to the client verbatim: `"YouTube URL is required"`, `"Invalid YouTube URL"`, and the Gemini timeout message. All other errors return a generic message.

---

## Observability

### Structured logging

All log entries are emitted as single-line JSON to stdout/stderr. Every entry includes `timestamp`, `level`, `event`, and where applicable `requestId`, `durationMs`, `method`, `path`, `status`, and `videoId`.

### Request IDs

`getRequestId` reads `x-request-id` from the incoming request header. If absent, a UUID is generated. The ID is propagated to all log entries for that request and returned in the `x-request-id` response header.

### Metrics

Prometheus metrics are exposed at `GET /api/metrics` using a custom `prom-client` registry. Default Node.js process metrics are intentionally excluded to avoid cardinality noise. Registered metrics:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | Histogram | `method`, `route` |
| `generate_stage_duration_seconds` | Histogram | `stage` |

`stage` values: `transcript_fetch`, `title_fetch`, `gemini_inference`, `db_insert`.

Route labels use static templates (e.g. `/api/notes/[id]`) — no UUIDs or dynamic values appear in metric labels.

### Health checks

`GET /api/health` executes `SELECT 1` against the database. Returns `200` on success, `503` on failure. The database connectivity state is included in the response body and logged.

### Generation timing

Each generation request logs per-stage durations: `transcriptFetchMs`, `titleFetchMs`, `geminiInferenceMs`, `dbInsertMs`, and `fallbackDurationMs` when the direct-video path is used.

### Local monitoring

A Docker Compose file (`docker-compose.prometheus.yml`) runs Prometheus (scraping `host.docker.internal:3000/api/metrics` every 15 s) and Grafana (with provisioned dashboards) locally for observability validation. This stack is not deployed to Vercel production. There is no production metrics collection backend configured in this repository.

---

## Security

- **Secrets** — `GEMINI_API_KEY`, `DATABASE_URL`, and `DATABASE_CA_CERT` are read from environment variables. `.env.local` is blocked by `.gitignore`. `DATABASE_CA_CERT` must never be set as a `NEXT_PUBLIC_*` variable.
- **URL validation** — `validateYouTubeUrl` parses the URL and checks the hostname against an allowlist (`youtube.com`, `www.youtube.com`, `youtu.be`) before any network request is made.
- **Parameterized SQL** — all database queries use positional parameters (`$1`, `$2`, …) via `pg`. No string interpolation.
- **PostgreSQL TLS** — in production (`NODE_ENV=production`), the pool is configured with `ssl: { ca: DATABASE_CA_CERT, rejectUnauthorized: true }`. `rejectUnauthorized: false` is explicitly avoided. In development and test environments, SSL is disabled.
- **Sanitized errors** — internal error details (stack traces, database errors, raw Gemini output) are logged server-side and never returned to the client.
- **Logging hygiene** — `requestId`, `videoId`, and `durationMs` are logged; no user-submitted content (URLs, transcripts) appears in log fields.
- **No authentication** — the application is currently unauthenticated. All notes are globally accessible.

---

## Performance

The main latency driver is Gemini inference. Optimizations applied:

- **Parallel fetching** — transcript extraction (`youtube-transcript`) and title fetching (`noembed.com`) run concurrently via `Promise.all`, eliminating the serial wait between them.
- **Database query projection** — `GET /api/notes` selects only the columns needed for the library view (`id`, `video_id`, `video_title`, `thumbnail_url`, `overview`, `created_at`), avoiding transfer of `detailed_notes` and array fields for the list endpoint.
- **Bounded result size** — the notes list is capped at 200 rows as an explicit safety limit while pagination is not implemented.
- **Index on `created_at`** — `idx_notes_created_at` on `notes(created_at DESC)` supports the `ORDER BY created_at DESC LIMIT $1` query used by the library endpoint.
- **Per-stage timing** — every generation request logs `transcriptFetchMs`, `titleFetchMs`, `geminiInferenceMs`, and `dbInsertMs` to surface bottlenecks.

Gemini inference remains the dominant component of end-to-end latency regardless of optimization.

---

## Testing & Quality

Tests are written with **Vitest 5** and run in the Node.js environment. All external dependencies (database, Gemini SDK, `youtube-transcript`, `fetch`) are mocked.

Test files in `tests/`:

| File | Coverage area |
|---|---|
| `generate.test.ts` | Full generation pipeline, transcript fallback, direct-video fallback, idempotency states (new key, completed replay, concurrent 409, stale reclaim, concurrent reclaim race, failure cleanup), error sanitization, parallel fetch concurrency |
| `transcript.test.ts` | `validateYouTubeUrl` allowlist/blocklist, `fetchTranscript` timeout behavior, `extractVideoTitle` fallback and timeout |
| `notes.test.ts` | `GET /api/notes` success and database failure |
| `notes-id.test.ts` | `GET /api/notes/[id]` (found, 404, 500), `DELETE /api/notes/[id]` (success, 500) |
| `health.test.ts` | `GET /api/health` — 200/503, `x-request-id` propagation, no internal error leakage |
| `metrics.test.ts` | Counter and histogram recording, `/api/metrics` content type and cache headers, absence of default Node.js metrics, no high-cardinality labels |
| `db.test.ts` | SSL config per environment, `query_timeout` configuration |

### Commands

```bash
npm test               # vitest run (all tests, no watch)
npm run test:watch     # vitest interactive watch mode
npm run lint           # ESLint
npx tsc --noEmit       # TypeScript type check
npm run build          # Next.js production build
```

### CI pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and pull request to `main`:

1. Install dependencies (`npm ci --legacy-peer-deps`)
2. `npm test`
3. `npm run lint`
4. `npx tsc --noEmit`
5. `npm run build`

---

## Local Development

### Prerequisites

- Node.js 20
- PostgreSQL (local or cloud — Supabase free tier is sufficient)
- Google Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
```

Edit `.env.local`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/codenotes
GEMINI_API_KEY=...

# Production only — Supabase root CA certificate (PEM string).
# Leave blank for local development.
DATABASE_CA_CERT=
```

`NODE_ENV` is set automatically by Next.js. Do not set it manually.

```bash
# 3. Run schema migration
npm run db:migrate

# 4. (Optional) Seed local data
npm run db:seed

# 5. Start development server
npm run dev
```

Application is available at `http://localhost:3000`.

### Local observability stack (optional)

```bash
docker compose -f docker-compose.prometheus.yml up -d
```

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`

Prometheus scrapes `/api/metrics` on the running Next.js dev server every 15 seconds.

---

## Deployment

```
GitHub
  │  push to main
  ▼
GitHub Actions CI
  │  test → lint → typecheck → build
  ▼
Vercel
  │  automatic deployment on CI pass
  ▼
Next.js (Node.js runtime)
  │
  ├── Supabase PostgreSQL  (DATABASE_URL + DATABASE_CA_CERT)
  └── Google Gemini API    (GEMINI_API_KEY)
```

Required environment variables in Vercel project settings:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase connection string with `?sslmode=require` |
| `GEMINI_API_KEY` | Google AI Studio key |
| `DATABASE_CA_CERT` | Supabase root CA certificate (PEM). Required — application will not start without it in production. |

Run `npm run db:migrate` once against the production database before the first deployment (or after any schema change).

---

## Known Limitations

- **No authentication** — notes are globally accessible. There is no per-user isolation.
- **No rate limiting** — the API has no public rate limiting.
- **Transcript extraction is external-dependent** — the `youtube-transcript` library depends on YouTube's caption delivery. Videos without captions trigger the Gemini direct-video fallback.
- **Direct-video fallback is slower** — Gemini processes the video URL natively, which adds latency compared to the transcript path.
- **Synchronous generation** — the request blocks until Gemini completes. Very long videos risk hitting the 75-second Gemini timeout or Vercel's function timeout.
- **No production metrics backend** — the `/api/metrics` Prometheus endpoint exists, but there is no production scraper configured. The Prometheus/Grafana stack is local-only.
- **Notes list is unpaginated** — `GET /api/notes` returns at most 200 notes. No cursor or offset pagination is implemented.

---

## Future Improvements

- User authentication and per-user note isolation
- Rate limiting and abuse protection
- Asynchronous generation (queue-based) to decouple response time from Gemini latency
- Full-text search across saved notes
- Export to Markdown or PDF
- Timestamp-linked notes tied to video playback position
- Production metrics collection backend
