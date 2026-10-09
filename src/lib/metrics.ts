import { Registry, Counter, Histogram, Gauge } from 'prom-client';

interface MetricsRegistryHolder {
  registry: Registry;
  httpRequestsTotal: Counter<string>;
  httpRequestDurationSeconds: Histogram<string>;
  generateStageDurationSeconds: Histogram<string>;
  queueJobsEnqueuedTotal: Counter<string>;
  queueJobDurationSeconds: Histogram<string>;
  queueActiveJobsGauge: Gauge<string>;
  queueJobFailuresTotal: Counter<string>;
  queueJobRetriesTotal: Counter<string>;
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

  const generateStageDurationSeconds = new Histogram({
    name: 'generate_stage_duration_seconds',
    help: 'Duration of generate pipeline stages in seconds',
    labelNames: ['stage'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  const queueJobsEnqueuedTotal = new Counter({
    name: 'codenotes_queue_jobs_enqueued_total',
    help: 'Total number of generation jobs enqueued in BullMQ',
    labelNames: ['queue'] as const,
    registers: [registry],
  });

  const queueJobDurationSeconds = new Histogram({
    name: 'codenotes_queue_job_duration_seconds',
    help: 'End-to-end execution time for BullMQ generation jobs in seconds',
    labelNames: ['queue', 'status'] as const,
    buckets: [1, 5, 10, 20, 30, 60, 90, 120],
    registers: [registry],
  });

  const queueActiveJobsGauge = new Gauge({
    name: 'codenotes_queue_active_jobs',
    help: 'Number of currently active jobs in BullMQ worker',
    labelNames: ['queue'] as const,
    registers: [registry],
  });

  const queueJobFailuresTotal = new Counter({
    name: 'codenotes_queue_job_failures_total',
    help: 'Total number of failed BullMQ generation jobs',
    labelNames: ['queue', 'error_code'] as const,
    registers: [registry],
  });

  const queueJobRetriesTotal = new Counter({
    name: 'codenotes_queue_job_retries_total',
    help: 'Total number of BullMQ job retries',
    labelNames: ['queue'] as const,
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
    generateStageDurationSeconds,
    queueJobsEnqueuedTotal,
    queueJobDurationSeconds,
    queueActiveJobsGauge,
    queueJobFailuresTotal,
    queueJobRetriesTotal,
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
export const generateStageDurationSeconds = holder.generateStageDurationSeconds;
export const queueJobsEnqueuedTotal = holder.queueJobsEnqueuedTotal;
export const queueJobDurationSeconds = holder.queueJobDurationSeconds;
export const queueActiveJobsGauge = holder.queueActiveJobsGauge;
export const queueJobFailuresTotal = holder.queueJobFailuresTotal;
export const queueJobRetriesTotal = holder.queueJobRetriesTotal;
export const rateLimitRejectionsTotal = holder.rateLimitRejectionsTotal;

export type GenerateStage =
  | 'transcript_fetch'
  | 'title_fetch'
  | 'gemini_inference'
  | 'db_insert';

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number
) {
  httpRequestsTotal.inc({ method, route, status: status.toString() });
  httpRequestDurationSeconds.observe({ method, route }, durationSeconds);
}

export function recordGenerateStageDuration(
  stage: GenerateStage,
  durationSeconds: number
) {
  generateStageDurationSeconds.observe({ stage }, durationSeconds);
}

export function recordQueueJobEnqueued(queueName = 'note-generation') {
  queueJobsEnqueuedTotal.inc({ queue: queueName });
}

export function recordQueueJobCompleted(queueName: string, durationSeconds: number) {
  queueJobDurationSeconds.observe({ queue: queueName, status: 'completed' }, durationSeconds);
}

export function recordQueueJobFailed(queueName: string, durationSeconds: number, errorCode = 'UNKNOWN') {
  queueJobDurationSeconds.observe({ queue: queueName, status: 'failed' }, durationSeconds);
  queueJobFailuresTotal.inc({ queue: queueName, error_code: errorCode });
}

export function recordQueueJobRetry(queueName = 'note-generation') {
  queueJobRetriesTotal.inc({ queue: queueName });
}

export function recordRateLimitRejection(endpoint = '/api/generate') {
  rateLimitRejectionsTotal.inc({ endpoint });
}
