import { Inngest, Middleware } from 'inngest';
import { extendedTracesMiddleware } from 'inngest/experimental';
import { flushTracing } from '@/lib/tracing';

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

class TracingFlushMiddleware extends Middleware.BaseMiddleware {
  id = 'codenotes:tracing-flush';

  async wrapRequest({ next }: any) {
    return next().finally(async () => {
      await flushTracing();
    });
  }
}

const globalForInngest = globalThis as unknown as { inngestClient?: Inngest };

export const inngest =
  globalForInngest.inngestClient ??
  new Inngest({
    id: 'codenotes',
    isDev: process.env.NODE_ENV !== 'production' || process.env.INNGEST_DEV === '1',
    checkpointing: {
      maxRuntime: '240s',
    },
    middleware: [
      extendedTracesMiddleware({ behaviour: 'off' }),
      TracingFlushMiddleware,
    ],
  });

globalForInngest.inngestClient = inngest;

/**
 * Generates a deterministic event ID to prevent duplicate event ingestion in Inngest.
 */
export function generateDeterministicEventId(userId: string, idempotencyKey: string): string {
  return `gen-${userId}-${idempotencyKey}`;
}
