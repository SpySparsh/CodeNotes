# CodeNotes Observability & Error Monitoring

CodeNotes includes a comprehensive, multi-layered observability stack combining structured JSON logging, Prometheus metrics, alerting rules, a Grafana dashboard, deep health checks, and privacy-safe Sentry error tracking.

---

## 1. Observability Architecture

```text
Application Events & Requests
  │
  ├── 1. Structured JSON Logs (stdout/stderr) ──► Terminal Console (custom JSON logger, no Pino)
  │
  ├── 2. In-Memory Registry (prom-client) ──────► /api/metrics (Bearer auth via METRICS_SECRET)
  │                                                 │
  │                                                 ├── Scraped by Prometheus (every 15s)
  │                                                 │     │
  │                                                 │     ├── Evaluates Alerts (alerts.yml)
  │                                                 │     └── Visualized in Grafana (codenotes.json)
  │
  ├── 3. Health Probe ──────────────────────────► /api/health (SELECT 1 DB probe, release metadata)
  │
  └── 4. Sentry SDK (with Sanitizer) ───────────► Strips PII / Tokens ──► Sentry Ingest (Terminal errors)
```

### Application Logging Architecture ([`src/lib/logger.ts`](../src/lib/logger.ts))
- **Custom JSON Logger**: Application logging is implemented with a lightweight custom logger emitting newline-delimited JSON. **Pino is not installed** in this project.
- **Log Outputs**:
  - `info` logs are emitted to `stdout` via `console.log`.
  - `warn` logs are emitted to `stderr` via `console.warn`.
  - `error` logs are emitted to `stderr` via `console.error`.
- **Log Entry Schema**: Each log entry contains `timestamp` (ISO string), `level` (`info` | `warn` | `error`), `event` name, optional correlation `requestId`, optional `durationMs` (rounded to 2 decimal places), and contextual metadata.
- **Log Inspection**: In local development, logs are inspected directly in the terminal where `npm run dev` is running.
- **Grafana Data Source Boundary**: The local Grafana instance is provisioned with **Prometheus metrics as its only data source**. Grafana does **not** ingest or query application log lines (no Loki, Vector, or Promtail pipeline exists). Metrics and logs are correlated manually by matching timestamps and request IDs between the Grafana panels and terminal logs.

### Cross-Service Distributed Tracing (`X-Request-ID`)
When an AI note generation job executes, correlation is preserved across the distributed boundary:
1. **Entrypoint Generation**: `POST /api/generate` accepts or derives an `idempotencyKey` and passes it in the Inngest event payload (`notes/generate.requested`).
2. **Outbound Transmission**: In Inngest Step 3 (`generate-ai-notes`), [`src/lib/ai-client.ts`](../src/lib/ai-client.ts) normalizes the ID to `^[a-zA-Z0-9_\-\.]{1,64}$` and transmits it in the HTTP header:
   ```http
   X-Request-ID: <idempotencyKey>
   ```
3. **FastAPI Middleware**: The Python microservice's `RequestIdMiddleware` ([`services/ai-generator/app/main.py`](../services/ai-generator/app/main.py)) sanitizes or adopts the header, binds it to `request.state.request_id`, attaches it to all Python structured log events, and returns it in the response header `x-request-id`.
4. **Log Correlation Across Vercel Projects**:
   To trace a job across both services in production:
   - Query Vercel Runtime Logs for `codenotes` searching by `requestId` (e.g. `ai_client_request_started`).
   - Query Vercel Runtime Logs for `codenotes-ai-generator` using the identical `requestId` to inspect token generation duration, Pydantic validation, or upstream Gemini errors.

---

## 2. Prometheus Metrics (`/api/metrics`)

The application registers and exposes Prometheus metrics at `/api/metrics` via a dedicated, curated registry in [`src/lib/metrics.ts`](../src/lib/metrics.ts). Default Node.js process metrics are excluded to keep telemetry focused and low-noise.

### Complete Metrics Catalog

| Metric Name | Type | Labels | Description |
| :--- | :---: | :--- | :--- |
| `http_requests_total` | Counter | `method`, `route`, `status` | Total incoming HTTP requests across normalized static routes |
| `http_request_duration_seconds` | Histogram | `method`, `route` | HTTP request execution latency (buckets: 5ms to 10s) |
| `codenotes_generation_jobs_total` | Counter | `status` (`started`, `completed`, `failed`, `replayed`) | Lifecycle counts of background note generation jobs |
| `codenotes_generation_stage_duration_seconds` | Histogram | `stage` (`claim`, `transcript_fetch`, `gemini_inference`, `db_persist`) | Execution latency of individual durable pipeline stages (`gemini_inference` measures the full Step 3 round-trip to the FastAPI service) |
| `codenotes_generation_duration_seconds` | Histogram | `status` (`completed`, `failed`) | End-to-end duration of the entire generation pipeline |
| `codenotes_transcript_requests_total` | Counter | `source` (`cache_hit`, `supadata`, `youtube_transcript_fallback`), `status` (`success`, `error`) | Transcript acquisition attempts by provider and outcome |
| `codenotes_transcript_duration_seconds` | Histogram | `provider` (`supadata`, `youtube_transcript`) | Upstream transcript provider network latency |
| `codenotes_ai_requests_total` | Counter | `model` (`gemini-2.5-flash`), `status` (`success`, `error`, `malformed_output`) | Gemini AI inference call counts and error classifications |
| `codenotes_ai_duration_seconds` | Histogram | `model` (`gemini-2.5-flash`) | Gemini AI inference latency (buckets: 1s to 90s) |
| `codenotes_rate_limit_rejections_total` | Counter | `endpoint` | Count of HTTP requests rejected due to token bucket exhaustion |
| `codenotes_reconciliation_runs_total` | Counter | `status` (`success`, `error`) | Executions of the stale generation reconciliation cron job |
| `codenotes_stale_jobs_recovered_total` | Counter | None | Total count of orphaned/stale jobs re-dispatched by the reconciler |

### Label Cardinality & Sanitization
All metrics use bounded, low-cardinality labels:
- Dynamic paths are normalized (e.g., `/api/notes/[id]`, not `/api/notes/c3f4a0b...`).
- Video IDs, user UUIDs, idempotency keys, and YouTube URLs are strictly excluded from metric labels.
- **Metrics vs. Logs**: Prometheus metric labels strictly use low-cardinality enumerations (e.g., `status: 'success' | 'error' | 'malformed_output'`). Internal error messages and failure details are **never** stored in Prometheus metrics; they are emitted to stderr as structured JSON logs (`logger.error`) with fields such as `errorMessage` and `status`.

### Metrics Scraping & Authentication (`METRICS_SECRET`)
The endpoint at `/api/metrics` enforces authentication based on deployment environment:
- **Preview & Production Environments** (`NODE_ENV === 'production'`, `VERCEL_ENV === 'production'`, or `VERCEL_ENV === 'preview'`):
  - Every scrape request must provide the header: `Authorization: Bearer <METRICS_SECRET>`.
  - Constant-time string comparison (`crypto.timingSafeEqual`) is used to protect against timing attacks.
  - If `METRICS_SECRET` is unset or blank in preview/production, the endpoint **fails closed** with HTTP `503 Service Unavailable`.
  - If the header is missing, malformed, or provides an incorrect token, the endpoint returns HTTP `401 Unauthorized`.
- **Local Development**:
  - If `METRICS_SECRET` is unset or blank, `/api/metrics` is publicly accessible without Bearer auth, allowing local Docker Prometheus to scrape out of the box.
  - If `METRICS_SECRET` is configured in `.env.local`, Bearer authentication is enforced locally as well.
- **Scrape Interval**: The Prometheus scraper ([`prometheus/prometheus.yml`](../prometheus/prometheus.yml)) scrapes `/api/metrics` every 15 seconds.

### Cumulative Counters vs. Rate-Based Dashboards
Prometheus counters (such as `http_requests_total` and `codenotes_generation_jobs_total`) are cumulative, monotonically increasing counters that reset to zero whenever the application process restarts. The Grafana dashboard panels calculate per-second rates using PromQL rate functions (e.g., `rate(http_requests_total[5m])`), ensuring panels reflect ongoing traffic and handle process restarts smoothly without anomalous cumulative spikes.

---

## 3. Important Architectural Limitation: Process-Local vs. Serverless Aggregation

> [!WARNING]
> **Process-Local Memory Constraint**:
> In Next.js, `prom-client` records metrics in Node.js process memory.
>
> - **In Local Development / Single-Server Deployments**: Prometheus directly scrapes `http://host.docker.internal:3000/api/metrics`, providing accurate, continuous metrics.
> - **In Distributed / Multi-Instance / Serverless Environments (e.g., Vercel, AWS Lambda)**: Each serverless function or container instance maintains its own isolated in-memory registry. A scrape request hitting one instance will only read metrics recorded by *that specific instance*, not globally aggregated counts across all active workers.
> - **Production Recommendation**: For horizontally autoscaled or serverless environments, metrics should be exported using Prometheus Pushgateway, OpenTelemetry (OTel) Collector, or a hosted time-series backend (e.g., Datadog, Grafana Cloud Agent) rather than process-local in-memory scraping.

---

## 4. Health Checks (`/api/health`)

CodeNotes exposes `/api/health` ([`src/app/api/health/route.ts`](../src/app/api/health/route.ts)) for uptime monitors, container liveness probes, and post-deployment release verification:
- Executes an active probe against PostgreSQL (`SELECT 1`).
- Measures database round-trip duration in milliseconds.
- Always returns an `x-request-id` response header for distributed tracing and request correlation.

### Response Payloads

#### Healthy Response (`200 OK`)
Returned when PostgreSQL is reachable and `SELECT 1` succeeds:
```json
{
  "status": "healthy",
  "timestamp": "2026-10-24T18:00:00.000Z",
  "database": "connected",
  "commit": "<full-40-character-commit-sha>",
  "environment": "production"
}
```

#### Unhealthy Response (`503 Service Unavailable`)
Returned when PostgreSQL is unreachable or connection pools are exhausted:
```json
{
  "status": "unhealthy",
  "timestamp": "2026-10-24T18:00:00.000Z",
  "database": "disconnected",
  "commit": "<full-40-character-commit-sha>",
  "environment": "production"
}
```

### Metadata and Information Disclosure Protections
- **Release Metadata**: `commit` exposes `VERCEL_GIT_COMMIT_SHA` as the full 40-character Git commit SHA in deployed environments (or `null` in local development when unset) and `environment` exposes `VERCEL_ENV` (trimmed, or `null` if unset).
- **Sensitive Detail Redaction**:
  To prevent leaking internal latency figures or database credentials/connection strings, **`durationMs` and `errorMessage` are never returned in the JSON response body**.
- **Diagnostic Destinations**:
  - `durationMs` is recorded in Prometheus metrics via `http_request_duration_seconds`.
  - On success, `logger.info('health_check_passed', { requestId, durationMs, database: 'healthy', ... })` is logged to `stdout`.
  - On failure, `logger.error('health_check_failed', { requestId, durationMs, errorMessage, ... })` is logged to `stderr`.

> [!NOTE]
> **Scrape Availability vs. Database Health**:
> - The Prometheus metric `up{job="codenotes"}` proves only that Prometheus can reach the HTTP server and scrape `/api/metrics`.
> - Active database health must be verified via the `/api/health` endpoint.

---

## 5. Prometheus Alerting Rules (`prometheus/rules/alerts.yml`)

The alert rules include minimum-traffic guards to prevent false alarms during idle development periods while maintaining sensitivity:

1. **`ServiceUnreachable`** (`critical`): Fires if `up{job="codenotes"} == 0` for 1 minute (Next.js server is down).
2. **`HighHttp5xxErrorRate`** (`critical`): Fires if 5xx errors exceed 5% over 5 minutes, with a minimum-volume guard of at least 5 requests (`sum(rate(http_requests_total[5m])) >= (5 / 300)`).
3. **`HighGenerationFailureRate`** (`warning`): Fires if failed generation jobs exceed 10% over 10 minutes, with a minimum-volume guard of at least 2 completed/failed jobs.
4. **`HighGeminiLatency`** (`warning`): Fires if Gemini 90th percentile latency exceeds 45s over 10 minutes, with a minimum-volume guard of at least 2 inference calls.
5. **`TranscriptProviderPrimaryFailure`** (`warning`): Fires if Supadata transcript error rate exceeds 20% over 10 minutes (indicating primary provider degradation and heavy reliance on the fallback scraper).

---

## 6. Grafana Dashboard (`grafana/dashboards/codenotes.json`)

The pre-provisioned Grafana dashboard organizes monitoring into **4 rows** containing **13 visualization panels**:

1. **Application Overview** (Row ID: `100` — 5 panels):
   - **Application Scrape Availability** (ID: `13`, `stat`): Gauges HTTP scrape availability (`up{job="codenotes"}`).
   - **Rate Limit Rejections** (ID: `4`, `timeseries`): Tracks 429 rate limit rejections (`sum by (endpoint) (rate(codenotes_rate_limit_rejections_total[5m]))`).
   - **HTTP Request Rate** (ID: `1`, `timeseries`): Request volume partitioned by route (`sum by (method, route) (rate(http_requests_total[5m]))`).
   - **HTTP Request Latency (Avg & p95)** (ID: `3`, `timeseries`): Average and 95th percentile request latency (`http_request_duration_seconds`).
   - **HTTP Error Rate (4xx & 5xx)** (ID: `2`, `timeseries`): Client (4xx) and Server (5xx) error rates as a fraction of total traffic (`http_requests_total`).

2. **Note Generation Pipeline (Inngest)** (Row ID: `101` — 4 panels):
   - **Generation Jobs by Status** (ID: `5`, `timeseries`): Job throughput across `started`, `completed`, `failed`, and `replayed` statuses (`codenotes_generation_jobs_total`).
   - **Generation Stage Latency (p95)** (ID: `6`, `timeseries`): 95th percentile duration for individual pipeline stages: `claim`, `transcript_fetch`, `gemini_inference`, and `db_persist` (`codenotes_generation_stage_duration_seconds`).
   - **End-to-End Generation Duration (p50 & p95)** (ID: `7`, `timeseries`): Median (p50) and 95th percentile full pipeline generation latency (`codenotes_generation_duration_seconds`).
   - **Reconciliation Runs & Stale Recoveries** (ID: `8`, `timeseries`): Hourly count of reconciliation cron runs and recovered stale jobs (`codenotes_reconciliation_runs_total` & `codenotes_stale_jobs_recovered_total`).

3. **Transcript Subsystem** (Row ID: `102` — 2 panels):
   - **Transcript Requests by Source & Status** (ID: `9`, `timeseries`): Acquisition volume across `cache_hit`, `supadata`, and `youtube_transcript_fallback` (`codenotes_transcript_requests_total`).
   - **Transcript Provider Latency (p95)** (ID: `10`, `timeseries`): 95th percentile network latency of upstream transcript providers (`codenotes_transcript_duration_seconds`).

4. **Gemini AI Inference** (Row ID: `103` — 2 panels):
   - **Gemini AI Requests by Status** (ID: `11`, `timeseries`): Inference counts partitioned by outcome: `success`, `error`, and `malformed_output` (`codenotes_ai_requests_total`).
   - **Gemini AI Inference Duration (p50, p90, p95)** (ID: `12`, `timeseries`): Median (p50), 90th percentile, and 95th percentile AI inference latency (`codenotes_ai_duration_seconds`).

---

## 7. Sentry Error Monitoring & Sanitization

CodeNotes uses `@sentry/nextjs` for error tracking across browser, server, and edge runtimes.

### Safe Optional Configuration
Sentry is completely optional. If `SENTRY_DSN` or `NEXT_PUBLIC_SENTRY_DSN` are unset:
- The SDK initializes in a disabled state (`enabled: Boolean(dsn)`).
- Exactly zero network requests or telemetry events are transmitted.
- Calls to `Sentry.captureException()` resolve safely as no-ops without throwing or crashing.

### Strict Data Sanitization ([`src/lib/sentry/sanitizer.ts`](file:///d:/unstuckstudy/src/lib/sentry/sanitizer.ts))
To prevent data leakage into Sentry logs:

1. **User PII Removal**:
   - `event.user` is deleted unconditionally on all captured events.
2. **Credential & Cookie Header Stripping**:
   - Headers `authorization`, `cookie`, `set-cookie`, `x-api-key`, and `x-inngest-signature` are stripped from all events and breadcrumbs.
3. **Sensitive Query Parameter Redaction**:
   - URL parameters `key`, `token`, `secret`, `password`, `auth`, `apikey`, `jwt`, `session`, and `code` are replaced with `[REDACTED]`.
4. **Regex Secret Pattern Scrubbing**:
   - Exception messages and text are scrubbed using regex patterns for Bearer tokens, Gemini API keys (`AIza...`), Supadata keys (`sd_...`), JWT tokens, and PostgreSQL connection strings.
5. **Heavy Payload Exclusion**:
   - Fields named `transcript`, `prompt`, `aiNotes`, `rawOutput`, `notes`, or request `body` are dropped regardless of object nesting depth.
6. **Bounded Inngest Scope**:
   - Inngest's `onFailure` handler records only bounded tags (`inngest.function: 'generate-notes'`, `error.code`, `error.unrecoverable`). Video IDs, user UUIDs, and idempotency keys are kept only in local structured logs.

---

## 8. PostHog Product Analytics & Privacy Architecture

CodeNotes integrates lightweight, client-side product analytics using `posthog-js` ([`src/lib/analytics/`](file:///d:/unstuckstudy/src/lib/analytics/)).

### Distinct Telemetry Roles
CodeNotes maintains strict role boundaries across telemetry systems:
- **Prometheus (`/api/metrics`)**: Operational service health, aggregate request rates, pipeline stage latencies, rate limits, and reconciler runs. Contains no user identifiers.
- **Sentry**: Error monitoring, uncaught exceptions, and unrecoverable pipeline crashes. User PII and content payloads are scrubbed unconditionally.
- **PostHog**: Product adoption, conversion, and feature usage analytics. Operates exclusively in the browser with explicit, privacy-first event capturing.

### Safe Optional Configuration
PostHog is completely optional. If `NEXT_PUBLIC_POSTHOG_KEY` is unset or blank:
- PostHog SDK initialization is skipped entirely (`isPostHogEnabled() === false`).
- Exactly zero network requests or beacons are transmitted.
- All tracking helper calls (`captureEvent`, `identifyUser`, `resetUser`, `capturePageView`) resolve immediately as no-ops.

### Strict Privacy Protections & Disabled Capabilities
To safeguard user privacy and prevent data leakage:
1. **Disabled Auto-Capture**: Automatic DOM interaction click/input tracking (`autocapture: false`), automatic pageview tracking (`capture_pageview: false`), and automatic pageleave tracking (`capture_pageleave: false`) are disabled.
2. **Disabled Recording & Surveys**: Session recordings (`disable_session_recording: true`) and in-app surveys (`disable_surveys: true`) are permanently disabled.
3. **Decide Endpoint Disabled**: Remote feature flag evaluation and experiment polling are turned off (`advanced_disable_decide: true`).
4. **Normalized Manual Pageviews**: Pageviews are tracked manually using sanitized template routes (`/`, `/library`, `/login`, `/signup`, `/notes/[id]`). Dynamic UUIDs, query strings, fragments, and OAuth callback codes are never tracked.
5. **PII and Content Exclusion**:
   - User identity uses the opaque Supabase user UUID (`user.id`). Email addresses and personal information are strictly forbidden and rejected at identification time.
   - User identity is immediately reset on logout via `resetUser()`.
   - **Forbidden Properties**: Property sanitization strictly blocks `video_id`, `note_id`, raw URLs, prompts, transcripts, AI summaries, code snippet contents, and unbounded error messages.
6. **Central `before_send` Privacy Filter**:
   - A global interceptor in `posthog.init` scrubs every outgoing event and drops unauthorized events.
   - Removes SDK default properties: `$referrer`, `$referring_domain`, session-entry/exit URLs (`$entry_current_url`, `$exit_current_url`), and attribution parameters (`utm_*`).
   - Normalizes `$current_url` and `$pathname` strictly into safe route templates (`/`, `/library`, `/login`, `/signup`, `/notes/[id]`), preventing accidental query string, fragment, or dynamic UUID transmission.

### Curated Product Event Catalog

| Event Name | Trigger Location | Allowed Properties | Privacy Boundary |
| :--- | :--- | :--- | :--- |
| `$pageview` | Route transitions (`PostHogProvider`) | `$current_url` (normalized route template) | No query params, fragments, or dynamic UUIDs |
| `user_signed_up` | Account creation (`/signup` or Google OAuth) | `method: 'email' \| 'google'` | Method only; no emails or user metadata |
| `user_logged_in` | User login (`/login` or Google OAuth) | `method: 'email' \| 'google'` | Method only; no emails or user credentials |
| `generation_requested` | URL submitted (`UrlInput`) | *(none)* | No `video_id` or YouTube URL transmitted |
| `generation_completed` | Polling succeeds (`UrlInput`) | `duration_ms` / `duration_seconds` | Latency only; deduplicated to fire once per lifecycle |
| `generation_failed` | Polling fails (`UrlInput`) | `error_code` (bounded enum) | Bounded enum; no raw exception messages |
| `note_viewed` | Note page loaded (`/notes/[id]`) | *(none)* | Deduplicated to fire once per unique note ID; no `note_id` |
| `code_copied` | Copy code clicked (`CodeBlock`) | `language` (bounded string) | Language name only; code snippet content excluded |
| `note_deleted` | Note removed (`/library`) | *(none)* | Only on successful deletion; no `note_id` transmitted |

---

## 9. Local Observability Setup & Safe Troubleshooting

The local monitoring stack is provisioned using Docker Compose in [`docker-compose.prometheus.yml`](../docker-compose.prometheus.yml).

### Starting the Stack
```bash
docker compose -f docker-compose.prometheus.yml up -d
```
- **Prometheus UI**: [http://localhost:9090](http://localhost:9090)
- **Grafana UI**: [http://localhost:3001](http://localhost:3001) (default credentials: `admin` / `admin`)
- **Dashboard**: "CodeNotes Overview" is auto-provisioned under General dashboards.
- **Datasource**: Pre-configured Prometheus datasource (`http://prometheus:9090`, UID `PBFA97CFB590B2093`).

### Handling Local Port Collisions
By default, Prometheus scrapes `http://host.docker.internal:3000/api/metrics`. If port `3000` is already in use by another local service on your machine:

1. **Run Next.js on an Alternate Port**:
   ```bash
   npm run dev -- -p 3100
   ```
2. **Point Prometheus to the Alternate Port**:
   To avoid modifying tracked repository files (`prometheus/prometheus.yml`), create an untracked temporary Prometheus scrape configuration or Docker Compose volume override that updates the scrape target to `host.docker.internal:3100`.

### Restricting Published Ports to Loopback (`127.0.0.1`)
In [`docker-compose.prometheus.yml`](../docker-compose.prometheus.yml), host port bindings default to all network interfaces (`0.0.0.0:9090` and `0.0.0.0:3001`). To restrict Prometheus and Grafana strictly to loopback (`127.0.0.1`) and prevent LAN exposure:

1. Create a local Compose override file (kept outside git tracking or gitignored, e.g. `docker-compose.loopback.yml`):
   ```yaml
   services:
     prometheus:
       ports: !override
         - "127.0.0.1:9090:9090"
     grafana:
       ports: !override
         - "127.0.0.1:3001:3000"
   ```
2. Launch with the override applied:
   ```bash
   docker compose -f docker-compose.prometheus.yml -f docker-compose.loopback.yml up -d
   ```
3. Inspect resolved bindings to confirm loopback restriction:
   ```bash
   docker compose -f docker-compose.prometheus.yml -f docker-compose.loopback.yml config
   ```

### Validating Monitoring Configuration
To verify the dashboard queries, Prometheus alert rules, and Docker Compose volume mount paths:
```bash
npm run validate:observability
```
This runs [`tests/observability-config.test.ts`](../tests/observability-config.test.ts) to statically check that all dashboard metrics and alerting rules conform to the approved metrics catalog.

For production deployment instructions, troubleshooting runbooks, and rollback procedures, see the [FastAPI Production Runbook](fastapi-production-runbook.md).
