import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  registry,
  recordHttpRequest,
  recordGenerationJob,
  recordGenerationStageDuration,
  recordGenerationDuration,
  recordReconciliationRun,
  recordStaleJobsRecovered,
  recordRateLimitRejection,
  recordTranscriptRequest,
  recordTranscriptDuration,
  recordAiRequest,
  recordAiDuration,
} from '@/lib/metrics';
import { GET as getMetrics } from '@/app/api/metrics/route';

describe('Prometheus Metrics Layer', () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it('records http_requests_total and http_request_duration_seconds', async () => {
    recordHttpRequest('GET', '/api/notes', 200, 0.045);
    recordHttpRequest('POST', '/api/generate', 400, 0.012);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('http_requests_total{method="GET",route="/api/notes",status="200"} 1');
    expect(metricsText).toContain('http_requests_total{method="POST",route="/api/generate",status="400"} 1');
    expect(metricsText).toContain('http_request_duration_seconds_count{method="GET",route="/api/notes"} 1');
    expect(metricsText).toContain('http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/notes"} 1');
  });

  it('records codenotes_generation_jobs_total across all valid lifecycle statuses', async () => {
    recordGenerationJob('started');
    recordGenerationJob('completed');
    recordGenerationJob('failed');
    recordGenerationJob('replayed');

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_generation_jobs_total');
    expect(metricsText).toContain('# TYPE codenotes_generation_jobs_total counter');
    expect(metricsText).toContain('codenotes_generation_jobs_total{status="started"} 1');
    expect(metricsText).toContain('codenotes_generation_jobs_total{status="completed"} 1');
    expect(metricsText).toContain('codenotes_generation_jobs_total{status="failed"} 1');
    expect(metricsText).toContain('codenotes_generation_jobs_total{status="replayed"} 1');
  });

  it('records codenotes_generation_stage_duration_seconds across all 4 stages', async () => {
    recordGenerationStageDuration('claim', 0.05);
    recordGenerationStageDuration('transcript_fetch', 0.25);
    recordGenerationStageDuration('gemini_inference', 1.5);
    recordGenerationStageDuration('db_persist', 0.03);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_generation_stage_duration_seconds');
    expect(metricsText).toContain('# TYPE codenotes_generation_stage_duration_seconds histogram');
    expect(metricsText).toContain('codenotes_generation_stage_duration_seconds_count{stage="claim"} 1');
    expect(metricsText).toContain('codenotes_generation_stage_duration_seconds_count{stage="transcript_fetch"} 1');
    expect(metricsText).toContain('codenotes_generation_stage_duration_seconds_count{stage="gemini_inference"} 1');
    expect(metricsText).toContain('codenotes_generation_stage_duration_seconds_count{stage="db_persist"} 1');
  });

  it('records codenotes_generation_duration_seconds for completed and failed statuses', async () => {
    recordGenerationDuration('completed', 12.4);
    recordGenerationDuration('failed', 4.1);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_generation_duration_seconds');
    expect(metricsText).toContain('# TYPE codenotes_generation_duration_seconds histogram');
    expect(metricsText).toContain('codenotes_generation_duration_seconds_count{status="completed"} 1');
    expect(metricsText).toContain('codenotes_generation_duration_seconds_count{status="failed"} 1');
  });

  it('records codenotes_reconciliation_runs_total and codenotes_stale_jobs_recovered_total', async () => {
    recordReconciliationRun('success');
    recordReconciliationRun('error');
    recordStaleJobsRecovered(3);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_reconciliation_runs_total');
    expect(metricsText).toContain('# TYPE codenotes_reconciliation_runs_total counter');
    expect(metricsText).toContain('codenotes_reconciliation_runs_total{status="success"} 1');
    expect(metricsText).toContain('codenotes_reconciliation_runs_total{status="error"} 1');

    expect(metricsText).toContain('# HELP codenotes_stale_jobs_recovered_total');
    expect(metricsText).toContain('# TYPE codenotes_stale_jobs_recovered_total counter');
    expect(metricsText).toContain('codenotes_stale_jobs_recovered_total 3');
  });

  it('records codenotes_rate_limit_rejections_total with low-cardinality endpoint label', async () => {
    recordRateLimitRejection('/api/generate');

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_rate_limit_rejections_total');
    expect(metricsText).toContain('# TYPE codenotes_rate_limit_rejections_total counter');
    expect(metricsText).toContain('codenotes_rate_limit_rejections_total{endpoint="/api/generate"} 1');
  });

  it('records codenotes_transcript_requests_total and codenotes_transcript_duration_seconds', async () => {
    recordTranscriptRequest('cache_hit', 'success');
    recordTranscriptRequest('supadata', 'success');
    recordTranscriptRequest('supadata', 'error');
    recordTranscriptRequest('youtube_transcript_fallback', 'success');
    recordTranscriptRequest('youtube_transcript_fallback', 'error');

    recordTranscriptDuration('supadata', 0.85);
    recordTranscriptDuration('youtube_transcript', 1.25);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_transcript_requests_total');
    expect(metricsText).toContain('# TYPE codenotes_transcript_requests_total counter');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="cache_hit",status="success"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="supadata",status="success"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="supadata",status="error"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="youtube_transcript_fallback",status="success"} 1');
    expect(metricsText).toContain('codenotes_transcript_requests_total{source="youtube_transcript_fallback",status="error"} 1');

    expect(metricsText).toContain('# HELP codenotes_transcript_duration_seconds');
    expect(metricsText).toContain('# TYPE codenotes_transcript_duration_seconds histogram');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="supadata"} 1');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds_count{provider="youtube_transcript"} 1');
  });

  it('records codenotes_ai_requests_total and codenotes_ai_duration_seconds', async () => {
    recordAiRequest('gemini-2.5-flash', 'success');
    recordAiRequest('gemini-2.5-flash', 'error');
    recordAiRequest('gemini-2.5-flash', 'malformed_output');

    recordAiDuration('gemini-2.5-flash', 4.5);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('# HELP codenotes_ai_requests_total');
    expect(metricsText).toContain('# TYPE codenotes_ai_requests_total counter');
    expect(metricsText).toContain('codenotes_ai_requests_total{model="gemini-2.5-flash",status="success"} 1');
    expect(metricsText).toContain('codenotes_ai_requests_total{model="gemini-2.5-flash",status="error"} 1');
    expect(metricsText).toContain('codenotes_ai_requests_total{model="gemini-2.5-flash",status="malformed_output"} 1');

    expect(metricsText).toContain('# HELP codenotes_ai_duration_seconds');
    expect(metricsText).toContain('# TYPE codenotes_ai_duration_seconds histogram');
    expect(metricsText).toContain('codenotes_ai_duration_seconds_count{model="gemini-2.5-flash"} 1');
  });

  it('/api/metrics endpoint returns successfully with Prometheus content type', async () => {
    recordHttpRequest('GET', '/api/health', 200, 0.005);
    recordGenerationJob('started');
    recordTranscriptRequest('cache_hit', 'success');
    recordAiRequest('gemini-2.5-flash', 'success');

    const response = await getMetrics();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(registry.contentType);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const body = await response.text();
    expect(body).toContain('# HELP http_requests_total');
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('http_requests_total{method="GET",route="/api/health",status="200"} 1');
    expect(body).toContain('codenotes_generation_jobs_total{status="started"} 1');
    expect(body).toContain('codenotes_transcript_requests_total{source="cache_hit",status="success"} 1');
    expect(body).toContain('codenotes_ai_requests_total{model="gemini-2.5-flash",status="success"} 1');
  });

  it('contains ONLY approved metric names and does not leak default node metrics or legacy bullmq metrics', async () => {
    recordHttpRequest('GET', '/api/notes', 200, 0.01);
    recordGenerationStageDuration('db_persist', 0.02);
    recordGenerationJob('started');
    recordTranscriptRequest('supadata', 'success');
    recordAiRequest('gemini-2.5-flash', 'success');

    const metricsText = await registry.metrics();

    // Approved metric names
    expect(metricsText).toContain('http_requests_total');
    expect(metricsText).toContain('http_request_duration_seconds');
    expect(metricsText).toContain('codenotes_generation_jobs_total');
    expect(metricsText).toContain('codenotes_generation_stage_duration_seconds');
    expect(metricsText).toContain('codenotes_generation_duration_seconds');
    expect(metricsText).toContain('codenotes_reconciliation_runs_total');
    expect(metricsText).toContain('codenotes_stale_jobs_recovered_total');
    expect(metricsText).toContain('codenotes_rate_limit_rejections_total');
    expect(metricsText).toContain('codenotes_transcript_requests_total');
    expect(metricsText).toContain('codenotes_transcript_duration_seconds');
    expect(metricsText).toContain('codenotes_ai_requests_total');
    expect(metricsText).toContain('codenotes_ai_duration_seconds');

    // Forbidden / Legacy metrics
    expect(metricsText).not.toContain('process_cpu_seconds_total');
    expect(metricsText).not.toContain('nodejs_eventloop_lag_seconds');
    expect(metricsText).not.toContain('db_queries_total');
    expect(metricsText).not.toContain('codenotes_queue_waiting_jobs');
    expect(metricsText).not.toContain('codenotes_queue_active_jobs');
    expect(metricsText).not.toContain('codenotes_queue_completed_jobs_total');
    expect(metricsText).not.toContain('codenotes_queue_failed_jobs_total');
    expect(metricsText).not.toContain('generate_stage_duration_seconds');
  });

  it('does NOT expose high-cardinality identifiers, sensitive query contents, or raw dynamic URLs', async () => {
    recordHttpRequest('GET', '/api/notes/[id]', 200, 0.02);

    const metricsText = await registry.metrics();

    // Verify static route label is used
    expect(metricsText).toContain('route="/api/notes/[id]"');

    // Verify no high cardinality UUIDs or sensitive keys appear
    expect(metricsText).not.toMatch(/requestId=/i);
    expect(metricsText).not.toMatch(/videoId=/i);
    expect(metricsText).not.toMatch(/youtube\.com/i);
    expect(metricsText).not.toMatch(/SELECT/i);
    expect(metricsText).not.toMatch(/INSERT/i);
  });
});

describe('/api/metrics Route Authentication & Access Controls', () => {
  const originalEnv = { ...process.env };

  const setEnv = (key: string, val?: string) => {
    if (val === undefined) {
      delete process.env[key];
    } else {
      (process.env as Record<string, string | undefined>)[key] = val;
    }
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
    registry.resetMetrics();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('valid Bearer token returns HTTP 200 and Prometheus metrics when authentication is enabled', async () => {
    setEnv('METRICS_SECRET', 'super-secret-metrics-token-12345');
    setEnv('NODE_ENV', 'production');

    recordHttpRequest('GET', '/api/notes', 200, 0.05);

    const req = new Request('https://example.com/api/metrics', {
      headers: {
        authorization: 'Bearer super-secret-metrics-token-12345',
      },
    });

    const res = await getMetrics(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(registry.contentType);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = await res.text();
    expect(body).toContain('http_requests_total{method="GET",route="/api/notes",status="200"} 1');
  });

  it('missing token returns HTTP 401 when authentication is enabled', async () => {
    setEnv('METRICS_SECRET', 'super-secret-metrics-token-12345');
    setEnv('NODE_ENV', 'production');

    const reqWithoutAuth = new Request('https://example.com/api/metrics');
    const res = await getMetrics(reqWithoutAuth);

    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = await res.text();
    expect(body).not.toContain('super-secret');
    expect(body).not.toContain('# HELP');
    expect(body).not.toContain('http_requests_total');
  });

  it('incorrect token returns HTTP 401 without throwing or leaking secret', async () => {
    setEnv('METRICS_SECRET', 'super-secret-metrics-token-12345');
    setEnv('NODE_ENV', 'production');

    // Different length
    const reqDiffLen = new Request('https://example.com/api/metrics', {
      headers: { authorization: 'Bearer wrong' },
    });
    const resDiffLen = await getMetrics(reqDiffLen);
    expect(resDiffLen.status).toBe(401);
    expect(await resDiffLen.text()).not.toContain('# HELP');

    // Same length, wrong characters
    const reqSameLen = new Request('https://example.com/api/metrics', {
      headers: { authorization: 'Bearer super-secret-metrics-token-XXXXX' },
    });
    const resSameLen = await getMetrics(reqSameLen);
    expect(resSameLen.status).toBe(401);
    expect(await resSameLen.text()).not.toContain('# HELP');

    // Empty Bearer token
    const reqEmpty = new Request('https://example.com/api/metrics', {
      headers: { authorization: 'Bearer ' },
    });
    const resEmpty = await getMetrics(reqEmpty);
    expect(resEmpty.status).toBe(401);
  });

  it('missing secret in production returns HTTP 503 and no metrics', async () => {
    setEnv('METRICS_SECRET', undefined);
    setEnv('NODE_ENV', 'production');

    const req = new Request('https://example.com/api/metrics', {
      headers: { authorization: 'Bearer some-random-token' },
    });
    const res = await getMetrics(req);

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = await res.text();
    expect(body).not.toContain('# HELP');
    expect(body).not.toContain('http_requests_total');
  });

  it('missing secret in preview deployment returns HTTP 503 and no metrics', async () => {
    setEnv('METRICS_SECRET', undefined);
    setEnv('NODE_ENV', 'development');
    setEnv('VERCEL_ENV', 'preview');

    const req = new Request('https://example.com/api/metrics');
    const res = await getMetrics(req);

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain('# HELP');
  });

  it('development mode without a secret preserves the local test workflow', async () => {
    setEnv('METRICS_SECRET', undefined);
    setEnv('VERCEL_ENV', undefined);
    setEnv('NODE_ENV', 'development');

    recordHttpRequest('GET', '/api/health', 200, 0.01);

    // Call without authorization header
    const req = new Request('https://example.com/api/metrics');
    const res = await getMetrics(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(registry.contentType);
    expect(res.headers.get('cache-control')).toContain('no-store');

    const body = await res.text();
    expect(body).toContain('# HELP http_requests_total');
  });

  it('development mode with a configured secret requires authentication', async () => {
    setEnv('METRICS_SECRET', 'local-dev-secret');
    setEnv('VERCEL_ENV', undefined);
    setEnv('NODE_ENV', 'development');

    // Unauthenticated request should be rejected even in development if secret is configured
    const reqWithoutAuth = new Request('https://example.com/api/metrics');
    const resWithoutAuth = await getMetrics(reqWithoutAuth);
    expect(resWithoutAuth.status).toBe(401);

    // Authenticated request succeeds
    const reqWithAuth = new Request('https://example.com/api/metrics', {
      headers: { authorization: 'Bearer local-dev-secret' },
    });
    const resWithAuth = await getMetrics(reqWithAuth);
    expect(resWithAuth.status).toBe(200);
  });

  it('error responses contain no secret or metrics payload', async () => {
    const sensitiveSecret = 'super-sensitive-secret-value-never-leak';
    setEnv('METRICS_SECRET', sensitiveSecret);
    setEnv('NODE_ENV', 'production');

    const res401 = await getMetrics(new Request('https://example.com/api/metrics'));
    const body401 = await res401.text();
    expect(body401).not.toContain(sensitiveSecret);
    expect(body401).not.toContain('# HELP');
    expect(body401).not.toContain('codenotes');

    setEnv('METRICS_SECRET', undefined);
    const res503 = await getMetrics(new Request('https://example.com/api/metrics'));
    const body503 = await res503.text();
    expect(body503).not.toContain(sensitiveSecret);
    expect(body503).not.toContain('# HELP');
    expect(body503).not.toContain('codenotes');
  });
});
