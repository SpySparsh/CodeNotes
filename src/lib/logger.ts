export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  requestId?: string;
  durationMs?: number;
  [key: string]: any;
}

export function log(level: LogLevel, event: string, metadata: Record<string, any> = {}) {
  const { requestId, durationMs, ...rest } = metadata;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(requestId ? { requestId } : {}),
    ...(typeof durationMs === 'number' ? { durationMs: Math.round(durationMs * 100) / 100 } : {}),
    ...rest,
  };

  const json = JSON.stringify(entry);

  if (level === 'error') {
    console.error(json);
  } else if (level === 'warn') {
    console.warn(json);
  } else {
    console.log(json);
  }
}

export const logger = {
  info: (event: string, metadata?: Record<string, any>) => log('info', event, metadata),
  warn: (event: string, metadata?: Record<string, any>) => log('warn', event, metadata),
  error: (event: string, metadata?: Record<string, any>) => log('error', event, metadata),
};
