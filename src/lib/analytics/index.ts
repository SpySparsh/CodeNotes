/**
 * src/lib/analytics/index.ts
 *
 * Public entrypoint for CodeNotes product analytics.
 */

export * from './events';
export * from './auth';
export {
  initPostHog,
  isPostHogEnabled,
  getPostHogConfig,
  identifyUser,
  resetUser,
  captureEvent,
  capturePageView,
} from './posthog';
