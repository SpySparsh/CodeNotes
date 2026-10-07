import { describe, it, expect } from 'vitest';
import { inngest, generateDeterministicEventId } from '@/inngest/client';

describe('Inngest Client & Deterministic Event IDs', () => {
  const userId = '123e4567-e89b-12d3-a456-426614174000';
  const idempotencyKey = 'client-idempotency-key-abc';

  it('instantiates Inngest client with codenotes app id and 240s checkpointing maxRuntime', () => {
    expect(inngest.id).toBe('codenotes');
    expect((inngest as any).options?.checkpointing?.maxRuntime).toBe('240s');
  });

  it('generates deterministic event ID that matches format gen-{userId}-{idempotencyKey}', () => {
    const eventId = generateDeterministicEventId(userId, idempotencyKey);
    expect(eventId).toBe(`gen-${userId}-${idempotencyKey}`);
  });

  it('generates identical event ID for identical inputs across multiple calls', () => {
    const id1 = generateDeterministicEventId(userId, idempotencyKey);
    const id2 = generateDeterministicEventId(userId, idempotencyKey);
    expect(id1).toBe(id2);
  });

  it('generates distinct event IDs for different users with same idempotency key', () => {
    const otherUserId = '999e4567-e89b-12d3-a456-426614174999';
    const id1 = generateDeterministicEventId(userId, idempotencyKey);
    const id2 = generateDeterministicEventId(otherUserId, idempotencyKey);
    expect(id1).not.toBe(id2);
  });
});
