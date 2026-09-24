import { describe, it, expect, beforeEach } from 'vitest';
import {
  registry,
  recordHttpRequest,
  recordGenerateStageDuration,
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

  it('records generate_stage_duration_seconds across all valid stages', async () => {
    recordGenerateStageDuration('transcript_fetch', 0.25);
    recordGenerateStageDuration('title_fetch', 0.1);
    recordGenerateStageDuration('gemini_inference', 1.5);
    recordGenerateStageDuration('db_insert', 0.03);

    const metricsText = await registry.metrics();

    expect(metricsText).toContain('generate_stage_duration_seconds_count{stage="transcript_fetch"} 1');
    expect(metricsText).toContain('generate_stage_duration_seconds_count{stage="title_fetch"} 1');
    expect(metricsText).toContain('generate_stage_duration_seconds_count{stage="gemini_inference"} 1');
    expect(metricsText).toContain('generate_stage_duration_seconds_count{stage="db_insert"} 1');
  });

  it('/api/metrics endpoint returns successfully with Prometheus content type', async () => {
    recordHttpRequest('GET', '/api/health', 200, 0.005);

    const response = await getMetrics();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(registry.contentType);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const body = await response.text();
    expect(body).toContain('# HELP http_requests_total');
    expect(body).toContain('# TYPE http_requests_total counter');
    expect(body).toContain('http_requests_total{method="GET",route="/api/health",status="200"} 1');
  });

  it('contains ONLY approved metric names and does not leak default node metrics or unapproved metrics', async () => {
    recordHttpRequest('GET', '/api/notes', 200, 0.01);
    recordGenerateStageDuration('db_insert', 0.02);

    const metricsText = await registry.metrics();

    // Approved metric names
    expect(metricsText).toContain('http_requests_total');
    expect(metricsText).toContain('http_request_duration_seconds');
    expect(metricsText).toContain('generate_stage_duration_seconds');

    // Forbidden metrics
    expect(metricsText).not.toContain('process_cpu_seconds_total');
    expect(metricsText).not.toContain('nodejs_eventloop_lag_seconds');
    expect(metricsText).not.toContain('db_queries_total');
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
