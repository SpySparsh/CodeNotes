import { describe, it, expect } from 'vitest';
import {
  DispatchAuthorizationTicket,
  createDispatchTicket,
  QuotaError,
} from '@/lib/quota-client';

describe('DispatchAuthorizationTicket Runtime Security Invariants', () => {
  const attemptId = 'c0a80101-0000-0000-0000-000000000001';
  const reservationToken = 'd0a80101-0000-0000-0000-000000000002';
  const generation = 1;
  const attemptNumber = 1;

  it('rejects direct manual instantiation without module secret', () => {
    expect(() => {
      new (DispatchAuthorizationTicket as any)(
        Symbol('FAKE_SECRET'),
        attemptId,
        reservationToken,
        generation,
        attemptNumber,
        'chunk'
      );
    }).toThrow(QuotaError);

    try {
      new (DispatchAuthorizationTicket as any)(
        Symbol('FAKE_SECRET'),
        attemptId,
        reservationToken,
        generation,
        attemptNumber,
        'chunk'
      );
    } catch (err: any) {
      expect(err.statusCode).toBe('UNAUTHORIZED_CONSTRUCTION');
    }
  });

  it('allows valid factory creation and single-use consumption', () => {
    const ticket = createDispatchTicket(
      attemptId,
      reservationToken,
      generation,
      attemptNumber,
      'chunk'
    );

    expect(ticket.attemptId).toBe(attemptId);
    expect(ticket.reservationToken).toBe(reservationToken);
    expect(ticket.generation).toBe(generation);
    expect(ticket.attemptNumber).toBe(attemptNumber);
    expect(ticket.operationType).toBe('chunk');
    expect(ticket.isConsumed).toBe(false);

    // Consume once
    ticket.consume('chunk', attemptId);
    expect(ticket.isConsumed).toBe(true);

    // Second consumption must throw ILLEGAL_TICKET_REUSE
    expect(() => ticket.consume('chunk', attemptId)).toThrow(QuotaError);
    try {
      ticket.consume('chunk', attemptId);
    } catch (err: any) {
      expect(err.statusCode).toBe('ILLEGAL_TICKET_REUSE');
    }
  });

  it('rejects consumption with mismatched operation type', () => {
    const ticket = createDispatchTicket(
      attemptId,
      reservationToken,
      generation,
      attemptNumber,
      'chunk'
    );

    expect(() => ticket.consume('monolithic', attemptId)).toThrow(QuotaError);
    try {
      ticket.consume('monolithic', attemptId);
    } catch (err: any) {
      expect(err.statusCode).toBe('TICKET_OPERATION_MISMATCH');
    }
  });

  it('rejects consumption with mismatched attempt ID', () => {
    const ticket = createDispatchTicket(
      attemptId,
      reservationToken,
      generation,
      attemptNumber,
      'synthesis'
    );

    expect(() => ticket.consume('synthesis', 'wrong-attempt-id')).toThrow(QuotaError);
    try {
      ticket.consume('synthesis', 'wrong-attempt-id');
    } catch (err: any) {
      expect(err.statusCode).toBe('TICKET_ATTEMPT_MISMATCH');
    }
  });

  it('rejects forged plain objects mimicking ticket structure', () => {
    const forgedPlainObject = {
      attemptId,
      reservationToken,
      generation,
      attemptNumber,
      operationType: 'chunk',
      consume: DispatchAuthorizationTicket.prototype.consume,
    };

    expect(() => {
      forgedPlainObject.consume('chunk', attemptId);
    }).toThrow(QuotaError);

    try {
      forgedPlainObject.consume('chunk', attemptId);
    } catch (err: any) {
      expect(err.statusCode).toBe('ILLEGAL_TICKET');
    }
  });
});
