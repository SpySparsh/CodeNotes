import { describe, it, expect, beforeEach } from 'vitest';
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
