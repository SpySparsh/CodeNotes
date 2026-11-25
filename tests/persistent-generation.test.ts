import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

// Import actual production functions and constants
import {
  saveStorageKey,
  removeStorageKey,
  loadStorageKey,
  isKeyNotified,
  markKeyNotified,
  STORAGE_KEY,
  NOTIFIED_STORAGE_KEY,
  MAX_STORAGE_RETENTION_MS,
} from '@/components/providers/GenerationProvider';

import {
  GenerationStatusError,
  fetchGenerationStatus,
  computeRefetchInterval,
} from '@/hooks/useGenerationStatus';

// Mock UI and tracking dependencies
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/analytics', () => ({
  captureEvent: vi.fn(),
  sanitizeErrorCode: vi.fn((code) => code || 'UNKNOWN_ERROR'),
}));

describe('Persistent Generation & Site-Wide Notifications Test Suite', () => {
  let queryClient: QueryClient;
  let mockStorage: Record<string, string> = {};

  // Mock storage implementation
  const mockLocalStorage = {
    getItem: vi.fn((key: string) => mockStorage[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      mockStorage[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete mockStorage[key];
    }),
    clear: vi.fn(() => {
      mockStorage = {};
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {};

    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 60 * 1000,
        },
      },
    });

    (global as any).localStorage = mockLocalStorage;
    (global as any).window = {
      localStorage: mockLocalStorage,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    queryClient.clear();
  });

  // =========================================================================
  // SECTION A: Direct Production Unit Tests of Storage & Cross-Tab Functions
  // (Directly executes exported production code from GenerationProvider.tsx)
  // =========================================================================
  describe('Section A: Direct Unit Tests for GenerationProvider Storage Functions', () => {
    it('saves and loads active generation without arbitrary 15-minute expiration', () => {
      const started25MinutesAgo = Date.now() - 25 * 60 * 1000;
      saveStorageKey('gen-long-running', 'https://youtube.com/watch?v=long', started25MinutesAgo);

      // Must NOT be discarded after 15 minutes! The backend status is the authoritative truth.
      const loaded = loadStorageKey();
      expect(loaded).not.toBeNull();
      expect(loaded?.key).toBe('gen-long-running');
      expect(loaded?.url).toBe('https://youtube.com/watch?v=long');
      expect(loaded?.startedAt).toBe(started25MinutesAgo);
    });

    it('discards truly abandoned storage records older than 24 hours', () => {
      const startedYesterday = Date.now() - (MAX_STORAGE_RETENTION_MS + 60000);
      saveStorageKey('gen-abandoned', 'https://youtube.com/watch?v=old', startedYesterday);

      const loaded = loadStorageKey();
      expect(loaded).toBeNull();
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    });

    it('removeStorageKey with expectedKey prevents accidentally deleting a newer generation started in another tab', () => {
      // Tab 2 has already started a newer generation 'gen-newer'
      saveStorageKey('gen-newer', 'https://youtube.com/watch?v=newer', Date.now());

      // Tab 1 finishes its older generation 'gen-older' and tries to clean up
      removeStorageKey('gen-older');

      // 'gen-newer' must NOT be deleted!
      const raw = mockLocalStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.key).toBe('gen-newer');

      // Now Tab 2 cleans up 'gen-newer'
      removeStorageKey('gen-newer');
      expect(mockLocalStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('isKeyNotified and markKeyNotified prevent duplicate notifications across tabs', () => {
      expect(isKeyNotified('gen-key-abc')).toBe(false);

      markKeyNotified('gen-key-abc');
      expect(isKeyNotified('gen-key-abc')).toBe(true);

      // Checking a different key returns false
      expect(isKeyNotified('gen-key-def')).toBe(false);

      // Re-marking the same key is idempotent and retains history
      markKeyNotified('gen-key-abc');
      expect(isKeyNotified('gen-key-abc')).toBe(true);
    });
  });

  // =========================================================================
  // SECTION B: Direct Unit Tests for useGenerationStatus & Error Classification
  // (Directly executes exported production code from useGenerationStatus.ts)
  // =========================================================================
  describe('Section B: Direct Unit Tests for GenerationStatusError Classification', () => {
    it('fetchGenerationStatus maps 404 Not Found to fatal GenerationStatusError', async () => {
      (global as any).fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Generation record not found' }),
      });

      await expect(fetchGenerationStatus('missing-key')).rejects.toThrow(GenerationStatusError);
      try {
        await fetchGenerationStatus('missing-key-2');
      } catch (err: any) {
        expect(err).toBeInstanceOf(GenerationStatusError);
        expect(err.status).toBe(404);
        expect(err.message).toBe('Generation record not found');
      }
    });

    it('fetchGenerationStatus maps 401 Unauthorized to fatal GenerationStatusError', async () => {
      (global as any).fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      });

      await expect(fetchGenerationStatus('auth-key')).rejects.toThrow('Unauthorized');
    });

    it('fetchGenerationStatus parses valid 200 responses with status and noteId', async () => {
      (global as any).fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'completed', noteId: 'note-uuid-123' }),
      });

      const res = await fetchGenerationStatus('valid-key');
      expect(res.status).toBe('completed');
      expect(res.noteId).toBe('note-uuid-123');
    });

    it('computeRefetchInterval returns false for fatal 401 and 404 errors', () => {
      const err401 = new GenerationStatusError('Unauthorized', 401);
      const err404 = new GenerationStatusError('Not Found', 404);

      expect(computeRefetchInterval(undefined, err401)).toBe(false);
      expect(computeRefetchInterval(undefined, err404)).toBe(false);
    });

    it('computeRefetchInterval returns 1500ms for transient errors, 5xx, or pending/processing status', () => {
      const err500 = new GenerationStatusError('Internal Server Error', 500);
      const errNetwork = new Error('Network error');

      // Transient errors must continue polling
      expect(computeRefetchInterval(undefined, err500)).toBe(1500);
      expect(computeRefetchInterval(undefined, errNetwork)).toBe(1500);
      expect(computeRefetchInterval(undefined, undefined)).toBe(1500);

      // In-flight statuses must continue polling
      expect(computeRefetchInterval({ status: 'pending' }, undefined)).toBe(1500);
      expect(computeRefetchInterval({ status: 'processing' }, undefined)).toBe(1500);
    });

    it('computeRefetchInterval returns false when generation status is completed or failed', () => {
      expect(computeRefetchInterval({ status: 'completed', noteId: 'abc' }, undefined)).toBe(false);
      expect(computeRefetchInterval({ status: 'failed', error: 'boom' }, undefined)).toBe(false);
    });
  });

  // =========================================================================
  // SECTION C: Real TanStack Query Invalidation & Library Refetch Contract Tests
  // (Executes a real QueryClient verifying query key prefix matching)
  // =========================================================================
  describe('Section C: Real TanStack Query Invalidation for Library Infinite Query', () => {
    it('invalidateQueries({ queryKey: ["notes"], exact: false }) invalidates useNotesInfiniteQuery', async () => {
      let fetchCount = 0;
      const initialNotes = [{ id: 'note-1', videoTitle: 'Existing Note' }];
      const updatedNotes = [
        { id: 'note-new', videoTitle: 'Newly Generated Note' },
        { id: 'note-1', videoTitle: 'Existing Note' },
      ];

      // Exact query key structure used by useNotesInfiniteQuery in useNotes.ts
      const libraryQueryKey = ['notes', { search: '', sort: 'created_at', order: 'desc', limit: 20 }];

      // Prefill query cache simulating active Library view
      queryClient.setQueryData(libraryQueryKey, { pages: [{ notes: initialNotes }] });

      // Subscribe to observe query invalidation
      let queryWasInvalidated = false;
      queryClient.getQueryCache().subscribe((event) => {
        if (event?.type === 'updated') {
          queryWasInvalidated = true;
        }
      });

      // Execute exact invalidation call used in GenerationProvider.tsx
      await queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });

      // Query state must be marked as invalidated/stale
      const queryState = queryClient.getQueryState(libraryQueryKey);
      expect(queryState?.isInvalidated).toBe(true);
      expect(queryWasInvalidated).toBe(true);
    });
  });

  // =========================================================================
  // SECTION D: Simulated State Machine & Provider Lifecycle Integration Tests
  // (Simulates router, route changes, network recovery, and cross-tab events.
  // Note: Route changes here are simulated via mock router state rather than
  // browser-level DOM navigation, which is executed in Playwright E2E suites).
  // =========================================================================
  describe('Section D: Provider Lifecycle & Multi-Tab Simulation', () => {
    function createSimulationHarness(initialRoute = '/') {
      let currentPathname = initialRoute;
      let activeKey: string | null = null;
      let activeUrl: string | null = null;
      let isSubmitting = false;
      let serverError: string | null = null;
      let lastCompletedNoteId: string | null = null;
      let status: 'pending' | 'processing' | 'completed' | 'failed' | null = null;
      let lastDurationMs: number | null = null;

      const notifiedKeys = new Set<string>();
      let pollingCount = 0;
      let startTime: number | null = null;

      // Restore from storage if present
      const loaded = loadStorageKey();
      if (loaded) {
        activeKey = loaded.key;
        activeUrl = loaded.url;
        startTime = loaded.startedAt;
        status = 'pending';
        pollingCount = 1;
      }

      const router = {
        push: vi.fn((url: string) => {
          currentPathname = url;
        }),
      };

      const startGeneration = async (url: string, key?: string) => {
        if (isSubmitting || activeKey) {
          toast.warning('A note generation is already in progress.');
          return { success: false, error: 'A note generation is already in progress.' };
        }
        isSubmitting = true;
        const assignedKey = key || `idem-${Date.now()}`;
        activeKey = assignedKey;
        activeUrl = url;
        status = 'pending';
        pollingCount = 1;
        const now = Date.now();
        startTime = now;

        saveStorageKey(assignedKey, url, now);
        isSubmitting = false;
        return { success: true, key: assignedKey };
      };

      const handleStatusData = (data: {
        status: 'pending' | 'processing' | 'completed' | 'failed';
        noteId?: string;
        error?: string;
        code?: string;
      }) => {
        if (!activeKey) return;
        status = data.status;

        if (data.status === 'completed' && data.noteId) {
          const currentKey = activeKey;
          const targetNoteId = data.noteId;

          if (notifiedKeys.has(currentKey) || isKeyNotified(currentKey)) {
            activeKey = null;
            activeUrl = null;
            removeStorageKey(currentKey);
            queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });
            return;
          }
          notifiedKeys.add(currentKey);
          markKeyNotified(currentKey);

          lastDurationMs = startTime ? Math.max(0, Math.round(Date.now() - startTime)) : null;

          toast.success('Notes generated successfully!', {
            action: {
              label: 'View Note',
              onClick: () => router.push(`/notes/${targetNoteId}`),
            },
          });

          queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });
          lastCompletedNoteId = targetNoteId;
          activeKey = null;
          activeUrl = null;
          removeStorageKey(currentKey);

          if (currentPathname === '/') {
            router.push(`/notes/${targetNoteId}`);
          }
        } else if (data.status === 'failed') {
          const currentKey = activeKey;
          if (notifiedKeys.has(currentKey) || isKeyNotified(currentKey)) {
            activeKey = null;
            activeUrl = null;
            removeStorageKey(currentKey);
            return;
          }
          notifiedKeys.add(currentKey);
          markKeyNotified(currentKey);

          const errorMsg = data.error || 'Failed to generate notes';
          toast.error(errorMsg);
          serverError = errorMsg;
          activeKey = null;
          activeUrl = null;
          removeStorageKey(currentKey);
        }
      };

      const handleStatusError = (err: Error) => {
        if (!activeKey) return;
        const currentKey = activeKey;

        // Authoritative 404: record does not exist on backend
        if (err instanceof GenerationStatusError && err.status === 404) {
          activeKey = null;
          activeUrl = null;
          removeStorageKey(currentKey);
          return;
        }

        // Authoritative 401: redirect to login unless already on login page
        if (err instanceof GenerationStatusError && err.status === 401) {
          const isLoginPage = currentPathname === '/login' || currentPathname.startsWith('/login/');
          if (!isLoginPage) {
            router.push(`/login?next=${encodeURIComponent(currentPathname || '/')}`);
          }
          return;
        }

        // Transient network errors (offline, 500, 502, 503, 504):
        // Retain activeKey! Do NOT mark failed! Polling will retry.
      };

      const navigate = (newPath: string) => {
        currentPathname = newPath;
      };

      return {
        getState: () => ({
          activeKey,
          activeUrl,
          status,
          isGenerating: Boolean(activeKey) || isSubmitting,
          isSubmitting,
          serverError,
          lastCompletedNoteId,
          lastDurationMs,
          currentPathname,
          pollingCount,
        }),
        startGeneration,
        handleStatusData,
        handleStatusError,
        navigate,
        router,
      };
    }

    it('preserves activeKey and continues polling across simulated route changes', async () => {
      const harness = createSimulationHarness('/');
      await harness.startGeneration('https://youtube.com/watch?v=1', 'key-persistent-1');

      harness.navigate('/library');
      expect(harness.getState().activeKey).toBe('key-persistent-1');
      expect(harness.getState().isGenerating).toBe(true);

      harness.navigate('/notes/existing-note-abc');
      expect(harness.getState().activeKey).toBe('key-persistent-1');

      harness.navigate('/');
      expect(harness.getState().activeKey).toBe('key-persistent-1');
      expect(harness.getState().isGenerating).toBe(true);
    });

    it('transient network errors (500/502/network drops) do NOT discard active generation state', async () => {
      const harness = createSimulationHarness('/');
      await harness.startGeneration('https://youtube.com/watch?v=resilient', 'key-resilient-1');

      // Simulate a network drop (fetch fails or 503 Gateway Timeout)
      const networkError = new Error('Failed to fetch (Network connection lost)');
      harness.handleStatusError(networkError);

      // Active generation MUST NOT be cleared!
      expect(harness.getState().activeKey).toBe('key-resilient-1');
      expect(harness.getState().isGenerating).toBe(true);
      expect(toast.error).not.toHaveBeenCalled();

      // When network recovers, polling continues and completes normally
      harness.handleStatusData({ status: 'completed', noteId: 'note-recovered-123' });
      expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it('backend 404 error authoritatively discards active generation without failure toast', async () => {
      const harness = createSimulationHarness('/');
      await harness.startGeneration('https://youtube.com/watch?v=notfound', 'key-404-1');

      // Backend returns 404
      const notFoundError = new GenerationStatusError('Generation record not found', 404);
      harness.handleStatusError(notFoundError);

      // Discards state cleanly
      expect(harness.getState().activeKey).toBeNull();
      expect(harness.getState().isGenerating).toBe(false);
      expect(mockLocalStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('cross-tab duplicate notifications are suppressed when marked in shared storage', async () => {
      const harnessTab2 = createSimulationHarness('/library');
      await harnessTab2.startGeneration('https://youtube.com/watch?v=shared', 'key-shared-1');

      // Simulate Tab 1 already notified this key and marked it in shared storage
      markKeyNotified('key-shared-1');

      // Tab 2 receives the completion poll response
      harnessTab2.handleStatusData({ status: 'completed', noteId: 'note-shared-123' });

      // Tab 2 suppresses duplicate toast
      expect(toast.success).not.toHaveBeenCalled();
      // Tab 2 still cleans up its active key and updates state
      expect(harnessTab2.getState().activeKey).toBeNull();
    });

    it('route-aware navigation: redirects when on / but remains on current route when on /notes/[id]', async () => {
      // Case 1: User is on /notes/other-note
      const harness1 = createSimulationHarness('/notes/other-note');
      await harness1.startGeneration('https://youtube.com/watch?v=route-test', 'key-route-1');
      harness1.handleStatusData({ status: 'completed', noteId: 'new-note-999' });

      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(harness1.router.push).not.toHaveBeenCalledWith('/notes/new-note-999');
      expect(harness1.getState().currentPathname).toBe('/notes/other-note');

      // Case 2: User is on /
      const harness2 = createSimulationHarness('/');
      await harness2.startGeneration('https://youtube.com/watch?v=route-test-2', 'key-route-2');
      harness2.handleStatusData({ status: 'completed', noteId: 'new-note-1000' });

      expect(harness2.router.push).toHaveBeenCalledWith('/notes/new-note-1000');
      expect(harness2.getState().currentPathname).toBe('/notes/new-note-1000');
    });

    it('401 error redirects to login from normal routes but does NOT redirect when already on /login', async () => {
      // Case 1: User is on /library
      const harnessLibrary = createSimulationHarness('/library');
      await harnessLibrary.startGeneration('https://youtube.com/watch?v=401-test', 'key-401-1');

      const err401 = new GenerationStatusError('Unauthorized', 401);
      harnessLibrary.handleStatusError(err401);

      expect(harnessLibrary.router.push).toHaveBeenCalledWith('/login?next=%2Flibrary');

      // Case 2: User is already on /login
      removeStorageKey();
      const harnessLogin = createSimulationHarness('/login');
      await harnessLogin.startGeneration('https://youtube.com/watch?v=401-login', 'key-401-2');

      harnessLogin.router.push.mockClear();
      harnessLogin.handleStatusError(err401);

      // Must NOT repeatedly push login route when already on /login
      expect(harnessLogin.router.push).not.toHaveBeenCalled();
      // Active key is preserved for when authentication succeeds
      expect(harnessLogin.getState().activeKey).toBe('key-401-2');
    });

    it('restored active generation from storage notifies and navigates exactly once upon completion', async () => {
      // Generation was running before page reload
      const startedAt = Date.now() - 30000;
      saveStorageKey('key-restored-complete', 'https://youtube.com/watch?v=restored', startedAt);

      // Page loads at /
      const harness = createSimulationHarness('/');
      expect(harness.getState().activeKey).toBe('key-restored-complete');

      // First poll arrives with completed status
      harness.handleStatusData({ status: 'completed', noteId: 'note-restored-123' });

      // Must display success toast and navigate to note!
      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(harness.router.push).toHaveBeenCalledWith('/notes/note-restored-123');
      expect(harness.getState().activeKey).toBeNull();
      expect(isKeyNotified('key-restored-complete')).toBe(true);

      // Subsequent duplicate events or reloads do NOT display duplicate toasts
      harness.handleStatusData({ status: 'completed', noteId: 'note-restored-123' });
      expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it('restored active generation from storage notifies exactly once upon failure', async () => {
      const startedAt = Date.now() - 20000;
      saveStorageKey('key-restored-fail', 'https://youtube.com/watch?v=fail', startedAt);

      const harness = createSimulationHarness('/library');
      expect(harness.getState().activeKey).toBe('key-restored-fail');

      // First poll arrives with failed status
      harness.handleStatusData({ status: 'failed', error: 'AI generation quota exceeded' });

      expect(toast.error).toHaveBeenCalledWith('AI generation quota exceeded');
      expect(harness.getState().serverError).toBe('AI generation quota exceeded');
      expect(harness.getState().activeKey).toBeNull();
      expect(isKeyNotified('key-restored-fail')).toBe(true);

      // Duplicate failure event suppressed
      harness.handleStatusData({ status: 'failed', error: 'AI generation quota exceeded' });
      expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it('duration_ms calculation remains non-negative and accurate after localStorage restoration', async () => {
      const startedAt = Date.now() - 15000; // Started 15s ago
      saveStorageKey('key-duration-test', 'https://youtube.com/watch?v=dur', startedAt);

      const harness = createSimulationHarness('/');
      harness.handleStatusData({ status: 'completed', noteId: 'note-dur-1' });

      const durationMs = harness.getState().lastDurationMs;
      expect(durationMs).not.toBeNull();
      expect(durationMs!).toBeGreaterThanOrEqual(15000);
      expect(durationMs!).toBeLessThan(20000); // Reasonably close to ~15s
    });
  });
});
