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

export async function fetchGenerationStatus(key: string): Promise<GenerationStatusResponse> {
  const response = await fetch(`/api/generate/status?key=${encodeURIComponent(key)}`);
  
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Unauthorized');
    }
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || 'Failed to check generation status');
  }

  return response.json();
}

export function useGenerationStatus(key: string | null) {
  return useQuery<GenerationStatusResponse, Error>({
    queryKey: ['generation-status', key],
    queryFn: () => {
      if (!key) throw new Error('No key provided');
      return fetchGenerationStatus(key);
    },
    enabled: Boolean(key),
    staleTime: 0,
    gcTime: 1000 * 60 * 5, // 5 minutes
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      if (data.status === 'completed' || data.status === 'failed') {
        return false;
      }
      return 1500; // Poll every 1.5 seconds
    },
    refetchIntervalInBackground: true,
  });
}
