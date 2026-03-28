'use client';

import { useState } from 'react';
import { Youtube, Search, ArrowRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import LoadingState from '@/components/LoadingState';

export default function UrlInput() {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    
    // basic validation
    if (!url.includes('youtube.com/watch') && !url.includes('youtu.be/')) {
      setError('Please enter a valid YouTube video URL');
      return;
    }
    
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate notes');
      }

      router.push(`/notes/${data.noteId}`);
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Something went wrong');
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return <LoadingState />;
  }

  return (
    <div className="w-full max-w-2xl mx-auto mt-12">
      <form onSubmit={handleSubmit} className="relative group focus-glow rounded-2xl transition-all duration-300">
        <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
          <Youtube className="h-6 w-6 text-slate-400 group-focus-within:text-red-500 transition-colors duration-300" />
        </div>
        <input
          type="text"
          className="block w-full pl-14 pr-36 py-5 bg-white border border-slate-200 rounded-2xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-4 focus:ring-purple-100 focus:border-purple-400 transition-all text-lg shadow-lg shadow-slate-200/40"
          placeholder="Paste a YouTube coding tutorial URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={isLoading}
        />
        <div className="absolute inset-y-0 right-2 flex items-center">
          <button
            type="submit"
            disabled={!url}
            className="flex items-center gap-2 px-6 py-3 bg-primary hover:bg-purple-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
          >
            <span className="flex items-center gap-2">
              Generate <ArrowRight size={18} />
            </span>
          </button>
        </div>
      </form>
      {error && (
        <p className="mt-4 text-red-500 text-center animate-in fade-in slide-in-from-top-2 font-medium bg-red-50 py-2 rounded-lg border border-red-100">{error}</p>
      )}
    </div>
  );
}
