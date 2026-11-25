'use client';

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Youtube, ArrowRight } from 'lucide-react';
import LoadingState from '@/components/LoadingState';
import { generateUrlSchema, GenerateUrlInput } from '@/lib/validations/generate';
import { useGeneration } from '@/hooks/useGeneration';

export default function UrlInput() {
  const {
    activeKey,
    isSubmitting,
    isGenerating,
    status,
    serverError,
    startGeneration,
  } = useGeneration();

  const {
    register,
    handleSubmit,
    formState: { errors },
    control,
    reset,
  } = useForm<GenerateUrlInput>({
    resolver: zodResolver(generateUrlSchema),
    defaultValues: {
      url: '',
    },
  });

  const urlValue = useWatch({ control, name: 'url' });

  const onSubmit = async (data: GenerateUrlInput) => {
    const res = await startGeneration(data.url);
    if (res.success) {
      reset();
    }
  };

  if (isSubmitting || activeKey || isGenerating) {
    return <LoadingState status={status || 'pending'} />;
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
          disabled={isSubmitting || isGenerating}
        />
        <div className="absolute inset-y-0 right-2 flex items-center">
          <button
            type="submit"
            disabled={!urlValue || isSubmitting || isGenerating}
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
