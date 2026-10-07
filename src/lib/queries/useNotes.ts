import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Note } from '@/lib/db';
import { SortField, SortOrder } from '@/lib/validations/notes';

export interface NotesApiResponse {
  success: boolean;
  notes: Note[];
  nextCursor: string | null;
  hasMore: boolean;
  error?: string;
}

export interface UseNotesOptions {
  search?: string;
  sort?: SortField;
  order?: SortOrder;
  limit?: number;
}

export function useNotesInfiniteQuery({
  search,
  sort = 'created_at',
  order = 'desc',
  limit = 20,
}: UseNotesOptions = {}) {
  return useInfiniteQuery<NotesApiResponse, Error>({
    queryKey: ['notes', { search: search || '', sort, order, limit }],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) {
        params.set('cursor', pageParam as string);
      }
      if (search && search.trim().length > 0) {
        params.set('search', search.trim());
      }
      if (sort) {
        params.set('sort', sort);
      }
      if (order) {
        params.set('order', order);
      }
      if (limit) {
        params.set('limit', String(limit));
      }

      const res = await fetch(`/api/notes?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) {
          const error: any = new Error('Unauthorized');
          error.status = 401;
          throw error;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch notes');
      }

      return res.json();
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
  });
}

export function useNoteQuery(id: string) {
  return useQuery<{ success: boolean; note: Note }, Error>({
    queryKey: ['notes', id],
    queryFn: async () => {
      const res = await fetch(`/api/notes/${id}`);
      if (!res.ok) {
        if (res.status === 401) {
          const error: any = new Error('Unauthorized');
          error.status = 401;
          throw error;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch note');
      }
      return res.json();
    },
    enabled: Boolean(id),
  });
}

export function useDeleteNoteMutation() {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/notes/${id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        if (res.status === 401) {
          const error: any = new Error('Unauthorized');
          error.status = 401;
          throw error;
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to delete note');
      }

      return res.json();
    },
    onSuccess: () => {
      // Invalidate all notes queries to trigger background refetch
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });
}
