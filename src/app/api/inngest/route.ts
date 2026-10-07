import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { generateNotesFunction } from '@/inngest/functions/generate-notes';
import { reconcileStaleGenerationsFunction } from '@/inngest/functions/reconcile-stale';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    generateNotesFunction,
    reconcileStaleGenerationsFunction,
  ],
});
