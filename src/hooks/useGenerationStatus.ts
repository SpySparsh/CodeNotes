'use client';

import { useQuery } from '@tanstack/react-query';

export type GenerationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationStatusResponse {
  status: GenerationStatus;
  noteId?: string;
  attempts?: number;
  error?: string;
  code?: string;
}

export class GenerationStatusError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'GenerationStatusError';
    this.status = status;
    this.code = code;
  }
}

export async function fetchGenerationStatus(key: string): Promise<GenerationStatusResponse> {
  const response = await fetch(`/api/generate/status?key=${encodeURIComponent(key)}`);

  if (!response.ok) {
    if (response.status === 401) {
      throw new GenerationStatusError('Unauthorized', 401);
    }
    const errData = await response.json().catch(() => ({}));
    throw new GenerationStatusError(
      errData.error || 'Failed to check generation status',
      response.status,
      errData.code
    );
  }

  return response.json();
}

export function computeRefetchInterval(
  data?: GenerationStatusResponse,
  error?: unknown
): number | false {
  // Do not poll on fatal unauthenticated or not-found status errors
  if (error instanceof GenerationStatusError && (error.status === 401 || error.status === 404)) {
    return false;
  }
  if (!data) return 1500;
  if (data.status === 'completed' || data.status === 'failed') {
    return false;
  }
  return 1500; // Poll every 1.5 seconds for pending/processing or transient errors
}

export function useGenerationStatus(key: string | null) {
  return useQuery<GenerationStatusResponse, GenerationStatusError | Error>({
    queryKey: ['generation-status', key],
    queryFn: () => {
      if (!key) throw new Error('No key provided');
      return fetchGenerationStatus(key);
    },
    enabled: Boolean(key),
    staleTime: 0,
    gcTime: 1000 * 60 * 5, // 5 minutes
    retry: (failureCount, error) => {
      // Do not retry fatal 404 (not found) or 401 (unauthorized) errors
      if (error instanceof GenerationStatusError && (error.status === 404 || error.status === 401)) {
        return false;
      }
      return failureCount < 5;
    },
    refetchInterval: (query) => computeRefetchInterval(query.state.data, query.state.error),
    refetchIntervalInBackground: true,
  });
}
