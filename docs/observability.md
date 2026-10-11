# CodeNotes Observability & Error Monitoring

CodeNotes includes a comprehensive, multi-layered observability stack combining structured JSON logging, Prometheus metrics, alerting rules, a Grafana dashboard, deep health checks, and privacy-safe Sentry error tracking.

---

## 1. Observability Architecture

```text
Application Events & Requests
  │
  ├── 1. Structured JSON Logs (stdout) ───► CloudWatch / Datadog / Console
  │
  ├── 2. In-Memory Registry (prom-client) ─► /api/metrics ──► Scraped by Prometheus (every 15s)
  │                                                                 │
  │                                                                 ├── Evaluates Alerts (alerts.yml)
  │                                                                 └── Visualized in Grafana (codenotes.json)
  │
  ├── 3. Health Probe ───────────────────► /api/health (SELECT 1 DB probe)
  │
  └── 4. Sentry SDK (with Sanitizer) ─────► Strips PII / Tokens ──► Sentry Ingest (Terminal errors only)
```

---

## 2. Prometheus Metrics (`/api/metrics`)

The application registers and exposes Prometheus metrics at `/api/metrics` via a dedicated, curated registry in [`src/lib/metrics.ts`](file:///d:/unstuckstudy/src/lib/metrics.ts). Default Node.js process metrics are excluded to keep telemetry focused and low-noise.

### Complete Metrics Catalog

| Metric Name | Type | Labels | Description |
| :--- | :---: | :--- | :--- |
| `http_requests_total` | Counter | `method`, `route`, `status` | Total incoming HTTP requests across normalized static routes |
| `http_request_duration_seconds` | Histogram | `method`, `route` | HTTP request execution latency (buckets: 5ms to 10s) |
| `codenotes_generation_jobs_total` | Counter | `status` (`started`, `completed`, `failed`, `replayed`) | Lifecycle counts of background note generation jobs |
| `codenotes_generation_stage_duration_seconds` | Histogram | `stage` (`claim`, `transcript_fetch`, `gemini_inference`, `db_persist`) | Execution latency of individual durable pipeline stages |
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

CodeNotes exposes `/api/health` ([`src/app/api/health/route.ts`](file:///d:/unstuckstudy/src/app/api/health/route.ts)) for uptime monitors and container liveness probes:
- Executes an active probe against PostgreSQL (`SELECT 1`).
- Measures database round-trip duration in milliseconds.
- Returns `200 OK` with JSON `{ status: "ok", database: "healthy", durationMs: 1.2 }` when connected.
- Returns `503 Service Unavailable` with JSON `{ status: "degraded", database: "unhealthy", errorMessage: "..." }` if the database is unreachable or connection pools are saturated.

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
