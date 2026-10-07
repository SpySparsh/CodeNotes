'use client';

import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Youtube, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import LoadingState from '@/components/LoadingState';
import { createClient } from '@/lib/supabase/client';
import { generateUrlSchema, GenerateUrlInput } from '@/lib/validations/generate';
import { useGenerationStatus } from '@/hooks/useGenerationStatus';
import { toast } from 'sonner';

export default function UrlInput() {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const isSubmittingRef = useRef(false);
  const router = useRouter();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const {
    register,
    handleSubmit,
    formState: { errors },
    watch,
    reset,
  } = useForm<GenerateUrlInput>({
    resolver: zodResolver(generateUrlSchema),
    defaultValues: {
      url: '',
    },
  });

  const urlValue = watch('url');

  // TanStack Query status polling hook
  const { data: statusData, error: statusError } = useGenerationStatus(activeKey);

  // Monitor generation status changes
  useEffect(() => {
    if (!statusData) return;

    if (statusData.status === 'completed' && statusData.noteId) {
      toast.success('Notes generated successfully!');
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      const targetNoteId = statusData.noteId;
      setActiveKey(null);
      setIsSubmitting(false);
      isSubmittingRef.current = false;
      reset();
      router.push(`/notes/${targetNoteId}`);
    } else if (statusData.status === 'failed') {
      const errorMsg = statusData.error || 'Failed to generate notes';
      toast.error(errorMsg);
      setServerError(errorMsg);
      setActiveKey(null);
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  }, [statusData, queryClient, router, reset]);

  // Handle polling network / authorization errors
  useEffect(() => {
    if (statusError) {
      const errorMsg = statusError.message || 'Failed to verify generation status';
      setServerError(errorMsg);
      toast.error(errorMsg);
      setActiveKey(null);
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  }, [statusError]);

  const onSubmit = async (data: GenerateUrlInput) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;

    // Verify user is authenticated before sending generation request
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        isSubmittingRef.current = false;
        router.push(`/login?next=${encodeURIComponent('/')}`);
        return;
      }
    } catch {
      isSubmittingRef.current = false;
      router.push(`/login?next=${encodeURIComponent('/')}`);
      return;
    }

    setServerError('');
    setIsSubmitting(true);

    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ url: data.url }),
      });

      const resData = await response.json();

      if (response.status === 401) {
        router.push(`/login?next=${encodeURIComponent('/')}`);
        return;
      }

      if (!response.ok && response.status !== 202) {
        throw new Error(resData.error || 'Failed to submit generation request');
      }

      if (response.status === 200 && resData.status === 'completed' && resData.noteId) {
        // Cache hit / already completed
        toast.success('Notes loaded from library!');
        queryClient.invalidateQueries({ queryKey: ['notes'] });
        reset();
        router.push(`/notes/${resData.noteId}`);
        return;
      }

      // 202 Accepted: asynchronous job in flight
      const returnedKey = resData.idempotencyKey || idempotencyKey;
      setActiveKey(returnedKey);
    } catch (err: any) {
      console.error(err);
      setServerError(err.message || 'Something went wrong');
      setIsSubmitting(false);
      isSubmittingRef.current = false;
    }
  };

  if (isSubmitting || activeKey) {
    return <LoadingState status={statusData?.status || 'pending'} />;
  }

  const displayError = errors.url?.message || serverError;

  return (
    <div className="w-full max-w-2xl mx-auto mt-12">
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="relative group focus-glow rounded-2xl transition-all duration-300"
      >
        <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
          <Youtube className="h-6 w-6 text-slate-400 group-focus-within:text-red-500 transition-colors duration-300" />
        </div>
        <input
          type="text"
          {...register('url')}
          className="block w-full pl-14 pr-36 py-5 bg-white border border-slate-200 rounded-2xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-4 focus:ring-purple-100 focus:border-purple-400 transition-all text-lg shadow-lg shadow-slate-200/40"
          placeholder="Paste a YouTube coding tutorial URL..."
          disabled={isSubmitting || !!activeKey}
        />
        <div className="absolute inset-y-0 right-2 flex items-center">
          <button
            type="submit"
            disabled={!urlValue || isSubmitting || !!activeKey}
            className="flex items-center gap-2 px-6 py-3 bg-primary hover:bg-purple-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md cursor-pointer"
          >
            <span className="flex items-center gap-2">
              Generate <ArrowRight size={18} />
            </span>
          </button>
        </div>
      </form>
      {displayError && (
        <p className="mt-4 text-red-500 text-center animate-in fade-in slide-in-from-top-2 font-medium bg-red-50 py-2.5 px-4 rounded-xl border border-red-100 text-sm">
          {displayError}
        </p>
      )}
    </div>
  );
}
