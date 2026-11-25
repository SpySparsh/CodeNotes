'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { captureEvent, sanitizeErrorCode } from '@/lib/analytics';
import {
  useGenerationStatus,
  GenerationStatus,
  GenerationStatusError,
} from '@/hooks/useGenerationStatus';

export const STORAGE_KEY = 'codenotes_active_generation';
export const NOTIFIED_STORAGE_KEY = 'codenotes_notified_generation_keys';
// Maximum retention for abandoned client keys before cleanup (24 hours)
export const MAX_STORAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface StoredGeneration {
  key: string;
  url: string;
  startedAt: number;
}

export function saveStorageKey(key: string, url: string, startedAt: number) {
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, url, startedAt }));
    }
  } catch {}
}

export function removeStorageKey(expectedKey?: string | null) {
  try {
    if (typeof window !== 'undefined') {
      if (expectedKey) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.key && parsed.key !== expectedKey) {
              // A newer generation is already active in storage. Do not remove it!
              return;
            }
          } catch {}
        }
      }
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

export function loadStorageKey(): StoredGeneration | null {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: StoredGeneration = JSON.parse(raw);
      if (parsed && parsed.key && typeof parsed.startedAt === 'number') {
        // Discard only obviously abandoned data older than 24 hours.
        // Active generations (even if taking > 15 minutes) are verified with the backend!
        if (Date.now() - parsed.startedAt < MAX_STORAGE_RETENTION_MS) {
          return parsed;
        }
      }
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
  return null;
}

export function isKeyNotified(key: string): boolean {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(NOTIFIED_STORAGE_KEY);
      if (raw) {
        const list: string[] = JSON.parse(raw);
        if (Array.isArray(list) && list.includes(key)) {
          return true;
        }
      }
    }
  } catch {}
  return false;
}

export function markKeyNotified(key: string) {
  try {
    if (typeof window !== 'undefined') {
      const raw = localStorage.getItem(NOTIFIED_STORAGE_KEY);
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(key)) {
        list.push(key);
        // Keep last 25 keys to prevent unbounded storage growth
        const trimmed = list.slice(-25);
        localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(trimmed));
      }
    }
  } catch {}
}

export interface GenerationContextValue {
  activeKey: string | null;
  activeUrl: string | null;
  status: GenerationStatus | null;
  isGenerating: boolean;
  isSubmitting: boolean;
  serverError: string | null;
  lastCompletedNoteId: string | null;
  startGeneration: (url: string) => Promise<{ success: boolean; noteId?: string; error?: string }>;
  clearGeneration: () => void;
  setServerError: (error: string | null) => void;
}

const GenerationContext = createContext<GenerationContextValue | undefined>(undefined);

export function GenerationProvider({ children }: { children: ReactNode }) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeUrl, setActiveUrl] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [lastCompletedNoteId, setLastCompletedNoteId] = useState<string | null>(null);

  const isSubmittingRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const notifiedKeysRef = useRef<Set<string>>(new Set());
  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;

  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const supabase = createClient();

  // Restore active generation on initial browser load
  useEffect(() => {
    const saved = loadStorageKey();
    if (saved && saved.key) {
      startTimeRef.current = saved.startedAt;
      setActiveKey(saved.key);
      setActiveUrl(saved.url || null);
    }
  }, []);

  // Multi-tab storage sync
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        if (e.newValue) {
          try {
            const parsed: StoredGeneration = JSON.parse(e.newValue);
            if (parsed && parsed.key && parsed.key !== activeKeyRef.current) {
              setActiveKey(parsed.key);
              setActiveUrl(parsed.url || null);
              startTimeRef.current = parsed.startedAt || Date.now();
            }
          } catch {}
        } else {
          // Storage key was removed in another tab.
          // Only clear if the removed key matches our current active key.
          if (e.oldValue) {
            try {
              const oldParsed = JSON.parse(e.oldValue);
              if (oldParsed?.key && oldParsed.key !== activeKeyRef.current) {
                // Another tab cleaned up an older generation; retain our current activeKey.
                return;
              }
            } catch {}
          }
          setActiveKey(null);
          setActiveUrl(null);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  // Single authoritative TanStack Query polling hook for the entire app
  const { data: statusData, error: statusError } = useGenerationStatus(activeKey);

  // Monitor generation status changes
  useEffect(() => {
    if (!statusData || !activeKey) return;

    if (statusData.status === 'completed' && statusData.noteId) {
      const targetNoteId = statusData.noteId;
      const currentKey = activeKey;

      // Check if already notified for this key in this tab or another tab
      if (notifiedKeysRef.current.has(currentKey) || isKeyNotified(currentKey)) {
        setActiveKey(null);
        setActiveUrl(null);
        removeStorageKey(currentKey);
        queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });
        return;
      }
      notifiedKeysRef.current.add(currentKey);
      markKeyNotified(currentKey);

      const durationMs = startTimeRef.current
        ? Math.max(0, Math.round(Date.now() - startTimeRef.current))
        : undefined;
      captureEvent('generation_completed', durationMs !== undefined ? { duration_ms: durationMs } : undefined);

      // Display global success notification with action to view note
      toast.success('Notes generated successfully!', {
        action: {
          label: 'View Note',
          onClick: () => router.push(`/notes/${targetNoteId}`),
        },
      });

      // Synchronize Library data automatically (matches ['notes', { ... }] infinite queries)
      queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });

      setLastCompletedNoteId(targetNoteId);
      setActiveKey(null);
      setActiveUrl(null);
      removeStorageKey(currentKey);

      // If user is currently waiting on the generation page, navigate to the generated note
      if (pathname === '/') {
        router.push(`/notes/${targetNoteId}`);
      }
    } else if (statusData.status === 'failed') {
      const currentKey = activeKey;

      if (notifiedKeysRef.current.has(currentKey) || isKeyNotified(currentKey)) {
        setActiveKey(null);
        setActiveUrl(null);
        removeStorageKey(currentKey);
        return;
      }
      notifiedKeysRef.current.add(currentKey);
      markKeyNotified(currentKey);

      captureEvent('generation_failed', {
        error_code: sanitizeErrorCode(statusData.code),
      });

      const errorMsg = statusData.error || 'Failed to generate notes';
      toast.error(errorMsg);
      setServerError(errorMsg);
      setActiveKey(null);
      setActiveUrl(null);
      removeStorageKey(currentKey);
    }
  }, [statusData, activeKey, queryClient, router, pathname]);

  // Handle fatal polling errors (e.g. 404 record not found or 401 unauthenticated)
  // Transient network errors (offline, timeout, 500/502/503) are NOT treated as failure and DO NOT clear state!
  useEffect(() => {
    if (!statusError || !activeKey) return;

    const currentKey = activeKey;

    if (statusError instanceof GenerationStatusError) {
      if (statusError.status === 404) {
        // Backend confirms record does not exist
        if (!notifiedKeysRef.current.has(currentKey)) {
          notifiedKeysRef.current.add(currentKey);
          markKeyNotified(currentKey);
        }
        setActiveKey(null);
        setActiveUrl(null);
        removeStorageKey(currentKey);
        return;
      }

      if (statusError.status === 401) {
        const isLoginPage = pathname === '/login' || Boolean(pathname?.startsWith('/login/'));
        if (!isLoginPage) {
          router.push(`/login?next=${encodeURIComponent(pathname || '/')}`);
        }
        return;
      }
    }

    // Transient network errors or temporary gateway failures:
    // Do NOT mark active generation failed! Do NOT remove activeKey!
    // TanStack Query will continue retrying on the background refetchInterval.
  }, [statusError, activeKey, router, pathname]);

  const startGeneration = useCallback(
    async (url: string) => {
      // Rule 1: A user can have only one active note generation at a time
      if (isSubmittingRef.current || activeKey) {
        const msg = 'A note generation is already in progress.';
        toast.warning(msg);
        return { success: false, error: msg };
      }

      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setServerError(null);

      // Verify user is authenticated before sending generation request
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          router.push(`/login?next=${encodeURIComponent('/')}`);
          return { success: false, error: 'Unauthorized' };
        }
      } catch {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        router.push(`/login?next=${encodeURIComponent('/')}`);
        return { success: false, error: 'Unauthorized' };
      }

      const idempotencyKey = crypto.randomUUID();

      try {
        const response = await fetch('/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ url }),
        });

        const resData = await response.json();

        if (response.status === 401) {
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          router.push(`/login?next=${encodeURIComponent('/')}`);
          return { success: false, error: 'Unauthorized' };
        }

        if (!response.ok && response.status !== 202) {
          throw new Error(resData.error || 'Failed to submit generation request');
        }

        if (response.status === 200 && resData.status === 'completed' && resData.noteId) {
          // Cache hit / already completed
          captureEvent('generation_requested');
          captureEvent('generation_completed', { duration_ms: 0 });
          toast.success('Notes loaded from library!');
          queryClient.invalidateQueries({ queryKey: ['notes'], exact: false });
          isSubmittingRef.current = false;
          setIsSubmitting(false);
          router.push(`/notes/${resData.noteId}`);
          return { success: true, noteId: resData.noteId };
        }

        // 202 Accepted: asynchronous job in flight
        captureEvent('generation_requested');
        const startedAt = Date.now();
        startTimeRef.current = startedAt;
        const returnedKey = resData.idempotencyKey || idempotencyKey;

        setActiveKey(returnedKey);
        setActiveUrl(url);
        saveStorageKey(returnedKey, url, startedAt);

        isSubmittingRef.current = false;
        setIsSubmitting(false);
        return { success: true };
      } catch (err: any) {
        console.error(err);
        const errorMsg = err.message || 'Something went wrong';
        setServerError(errorMsg);
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        toast.error(errorMsg);
        return { success: false, error: errorMsg };
      }
    },
    [activeKey, router, supabase, queryClient]
  );

  const clearGeneration = useCallback(() => {
    const currentKey = activeKeyRef.current;
    setActiveKey(null);
    setActiveUrl(null);
    setServerError(null);
    removeStorageKey(currentKey);
  }, []);

  const computedStatus = isSubmitting
    ? 'pending'
    : statusData?.status || (activeKey ? 'pending' : null);

  const isGenerating = Boolean(activeKey) || isSubmitting;

  const value: GenerationContextValue = {
    activeKey,
    activeUrl,
    status: computedStatus,
    isGenerating,
    isSubmitting,
    serverError,
    lastCompletedNoteId,
    startGeneration,
    clearGeneration,
    setServerError,
  };

  return <GenerationContext.Provider value={value}>{children}</GenerationContext.Provider>;
}

export function useGeneration(): GenerationContextValue {
  const context = useContext(GenerationContext);
  if (!context) {
    throw new Error('useGeneration must be used within a GenerationProvider');
  }
  return context;
}
