import { Inngest } from 'inngest';

export interface NoteGenerateEventData {
  userId: string;
  idempotencyKey: string;
  videoId: string;
  videoUrl: string;
}

export type Events = {
  'notes/generate.requested': {
    data: NoteGenerateEventData;
  };
};

export const inngest = new Inngest({
  id: 'codenotes',
  isDev: process.env.NODE_ENV !== 'production' || process.env.INNGEST_DEV === '1',
  checkpointing: {
    maxRuntime: '240s',
  },
});

/**
 * Generates a deterministic event ID to prevent duplicate event ingestion in Inngest.
 */
export function generateDeterministicEventId(userId: string, idempotencyKey: string): string {
  return `gen-${userId}-${idempotencyKey}`;
}
