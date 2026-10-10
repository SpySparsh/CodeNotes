import * as Sentry from '@sentry/nextjs';
import { sanitizeEvent, sanitizeBreadcrumb } from './src/lib/sentry/sanitizer';

const dsn = process.env.SENTRY_DSN;

if (!Sentry.getClient()) {
  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment: process.env.NODE_ENV || 'development',
    beforeSend: sanitizeEvent,
    beforeBreadcrumb: sanitizeBreadcrumb,
    tracesSampleRate: 0,
  });
}
