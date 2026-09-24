import { Registry, Counter, Histogram } from 'prom-client';

interface MetricsRegistryHolder {
  registry: Registry;
  httpRequestsTotal: Counter<string>;
  httpRequestDurationSeconds: Histogram<string>;
  generateStageDurationSeconds: Histogram<string>;
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

  return {
    registry,
    httpRequestsTotal,
    httpRequestDurationSeconds,
    generateStageDurationSeconds,
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
