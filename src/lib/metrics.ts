import { Registry, Counter, Histogram } from 'prom-client';

export type GenerationJobStatus = 'started' | 'completed' | 'failed' | 'replayed';
export type GenerationStage = 'claim' | 'transcript_fetch' | 'gemini_inference' | 'db_persist';
export type ReconciliationStatus = 'success' | 'error';

interface MetricsRegistryHolder {
  registry: Registry;
  httpRequestsTotal: Counter<string>;
  httpRequestDurationSeconds: Histogram<string>;
  generationJobsTotal: Counter<string>;
  generationStageDurationSeconds: Histogram<string>;
  generationDurationSeconds: Histogram<string>;
  reconciliationRunsTotal: Counter<string>;
  staleJobsRecoveredTotal: Counter<string>;
  rateLimitRejectionsTotal: Counter<string>;
}

declare global {
  var __METRICS_REGISTRY_HOLDER__: MetricsRegistryHolder | undefined;
}

function initializeMetrics(): MetricsRegistryHolder {
  const registry = new Registry();

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const generationJobsTotal = new Counter({
    name: 'codenotes_generation_jobs_total',
    help: 'Total number of generation jobs across lifecycle states',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  const generationStageDurationSeconds = new Histogram({
    name: 'codenotes_generation_stage_duration_seconds',
    help: 'Duration of individual Inngest generation durable steps in seconds',
    labelNames: ['stage'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90],
    registers: [registry],
  });

  const generationDurationSeconds = new Histogram({
    name: 'codenotes_generation_duration_seconds',
    help: 'End-to-end execution duration for note generation jobs in seconds',
    labelNames: ['status'] as const,
    buckets: [1, 5, 10, 20, 30, 60, 90, 120, 180],
    registers: [registry],
  });

  const reconciliationRunsTotal = new Counter({
    name: 'codenotes_reconciliation_runs_total',
    help: 'Total number of stale generation reconciliation cron runs',
    labelNames: ['status'] as const,
    registers: [registry],
  });

  const staleJobsRecoveredTotal = new Counter({
    name: 'codenotes_stale_jobs_recovered_total',
    help: 'Total number of stale generation jobs recovered and re-dispatched to Inngest',
    registers: [registry],
  });

  const rateLimitRejectionsTotal = new Counter({
    name: 'codenotes_rate_limit_rejections_total',
    help: 'Total number of rate limit rejections',
    labelNames: ['endpoint'] as const,
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    generationJobsTotal,
    generationStageDurationSeconds,
    generationDurationSeconds,
    reconciliationRunsTotal,
    staleJobsRecoveredTotal,
    rateLimitRejectionsTotal,
  };
}

const holder: MetricsRegistryHolder =
  globalThis.__METRICS_REGISTRY_HOLDER__ ?? initializeMetrics();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__METRICS_REGISTRY_HOLDER__ = holder;
}

export const registry = holder.registry;
export const httpRequestsTotal = holder.httpRequestsTotal;
export const httpRequestDurationSeconds = holder.httpRequestDurationSeconds;
export const generationJobsTotal = holder.generationJobsTotal;
export const generationStageDurationSeconds = holder.generationStageDurationSeconds;
export const generationDurationSeconds = holder.generationDurationSeconds;
export const reconciliationRunsTotal = holder.reconciliationRunsTotal;
export const staleJobsRecoveredTotal = holder.staleJobsRecoveredTotal;
export const rateLimitRejectionsTotal = holder.rateLimitRejectionsTotal;

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number
) {
  httpRequestsTotal.inc({ method, route, status: status.toString() });
  httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
}

export function recordGenerationJob(status: GenerationJobStatus) {
  generationJobsTotal.inc({ status });
}

export function recordGenerationStageDuration(
  stage: GenerationStage,
  durationSeconds: number
) {
  generationStageDurationSeconds.observe({ stage }, durationSeconds);
}

export function recordGenerationDuration(
  status: 'completed' | 'failed',
  durationSeconds: number
) {
  generationDurationSeconds.observe({ status }, durationSeconds);
}

export function recordReconciliationRun(status: ReconciliationStatus) {
  reconciliationRunsTotal.inc({ status });
}

export function recordStaleJobsRecovered(count = 1) {
  staleJobsRecoveredTotal.inc(count);
}

export function recordRateLimitRejection(endpoint = '/api/generate') {
  rateLimitRejectionsTotal.inc({ endpoint });
}
