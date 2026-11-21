import { describe, it, expect } from 'vitest';
import { classifyAttemptOutcome } from '@/lib/quota-client';

describe('Attempt Outcome Classification & Ambiguous Provider Accounting', () => {
  it('classifies timeouts as ambiguous', () => {
    expect(classifyAttemptOutcome({ code: 'TIMEOUT', message: 'Timed out' })).toBe('ambiguous');
    expect(classifyAttemptOutcome({ statusCode: 504, message: 'Gateway Timeout' })).toBe('ambiguous');
    expect(classifyAttemptOutcome({ name: 'AbortError', message: 'The operation was aborted' })).toBe('ambiguous');
    expect(classifyAttemptOutcome({ message: 'AI generation timed out after 85 seconds' })).toBe('ambiguous');
  });

  it('classifies network connection terminations as ambiguous', () => {
    expect(classifyAttemptOutcome({ code: 'ECONNRESET', message: 'Connection reset by peer' })).toBe('ambiguous');
    expect(classifyAttemptOutcome({ code: 'ETIMEDOUT', message: 'Connection timed out' })).toBe('ambiguous');
    expect(classifyAttemptOutcome({ code: 'NETWORK_ERROR', message: 'Network dropped' })).toBe('ambiguous');
  });

  it('classifies definitive rate limits as rejected_quota', () => {
    expect(classifyAttemptOutcome({ code: 'RATE_LIMITED', statusCode: 429 })).toBe('rejected_quota');
    expect(classifyAttemptOutcome({ statusCode: 429 })).toBe('rejected_quota');
  });

  it('classifies definitive server 503 as failed_transient', () => {
    expect(classifyAttemptOutcome({ statusCode: 503, isRetryable: true, message: 'Service Unavailable' })).toBe('failed_transient');
  });

  it('classifies null or successful errors as completed', () => {
    expect(classifyAttemptOutcome(null)).toBe('completed');
    expect(classifyAttemptOutcome(undefined)).toBe('completed');
  });
});
