'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Youtube, ChevronLeft, Bot, Lightbulb, Code2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import CodeBlock from '@/components/CodeBlock';
import { Note } from '@/lib/db';

export default function NotePage() {
  const { id } = useParams();
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchNote = async () => {
      try {
        const res = await fetch(`/api/notes/${id}`);
        const data = await res.json();
        
        if (!res.ok) throw new Error(data.error || 'Failed to fetch note');
        
        setNote(data.note);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (id) fetchNote();
  }, [id]);

  if (loading) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 py-12 space-y-8 animate-pulse">
        <div className="h-8 w-1/4 bg-gray-800 rounded"></div>
        <div className="h-32 w-full bg-gray-800/50 rounded-2xl"></div>
        <div className="space-y-4">
          <div className="h-6 w-1/3 bg-gray-800 rounded"></div>
          <div className="h-4 w-full bg-gray-800/30 rounded"></div>
          <div className="h-4 w-5/6 bg-gray-800/30 rounded"></div>
        </div>
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="w-full max-w-4xl mx-auto px-4 py-20 text-center">
        <h2 className="text-2xl font-bold text-red-400 mb-4">Error Loading Note</h2>
        <p className="text-muted-foreground mb-8">{error || 'Note not found'}</p>
        <Link href="/library" className="px-6 py-3 bg-card border border-border/50 rounded-xl hover:bg-card/80 transition-colors">
          Return to Library
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto px-4 py-8 md:py-16">
      {/* Header */}
      <Link href="/library" className="inline-flex items-center gap-2 text-slate-500 hover:text-primary mb-10 transition-colors group font-medium">
        <ChevronLeft size={16} className="group-hover:-translate-x-1 transition-transform" />
        Back to Library
      </Link>

      <div className="mb-14 relative">
        <h1 className="text-4xl md:text-5xl font-extrabold text-slate-900 mb-6 leading-tight tracking-tight">
          {note.videoTitle}
        </h1>
        <div className="flex items-center gap-4">
          <a 
            href={note.videoUrl} 
            target="_blank" 
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 text-primary hover:text-purple-700 font-medium transition-colors bg-purple-50 px-5 py-2.5 rounded-full text-sm border border-purple-100 shadow-sm"
          >
            <Youtube size={18} /> Watch Original Video
          </a>
        </div>
      </div>

      <div className="space-y-16">
        {/* Overview */}
        <section>
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg"><Bot size={20} /></div>
            <h2 className="text-xl font-bold text-slate-900 m-0 uppercase tracking-widest text-sm">Overview</h2>
          </div>
          <p className="text-xl text-slate-700 leading-relaxed font-medium">
            {note.overview}
          </p>
        </section>

        {/* Key Concepts */}
        {note.keyConcepts && note.keyConcepts.length > 0 && (
          <section className="bg-slate-50 border border-slate-100 rounded-2xl p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-amber-50 text-amber-600 rounded-lg"><Lightbulb size={20} /></div>
              <h2 className="text-xl font-bold text-slate-900 m-0">Key Concepts</h2>
            </div>
            <ul className="grid md:grid-cols-2 gap-4">
              {note.keyConcepts.map((concept, idx) => (
                <li key={idx} className="flex items-start gap-3 text-slate-700 font-medium">
                  <span className="text-amber-500 mt-1"><Check size={16} /></span>
                  {concept}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Detailed Notes with Inline Code and Tables */}
        <section className="prose-premium w-full">
          <ReactMarkdown 
            remarkPlugins={[remarkGfm]}
            components={{
              code({node, inline, className, children, ...props}: any) {
                const match = /language-(\w+)/.exec(className || '');
                if (!inline && match) {
                  return (
                    <CodeBlock 
                      language={match[1]} 
                      code={String(children).replace(/\\n$/, '')} 
                    />
                  );
                }
                return <code className="bg-slate-100 text-purple-700 px-1.5 py-0.5 rounded font-mono text-sm" {...props}>{children}</code>;
              }
            }}
          >
            {note.detailedNotes}
          </ReactMarkdown>
        </section>

        {/* Shorthands */}
        {note.shorthands && note.shorthands.length > 0 && (
          <section className="border-t border-slate-200 pt-10">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg"><Code2 size={20} /></div>
              <h2 className="text-2xl font-bold text-slate-900 m-0 tracking-tight">Shorthands & Quick Tips</h2>
            </div>
            <div className="grid gap-4">
              {note.shorthands.map((shorthand, idx) => (
                <div key={idx} className="flex gap-4 p-5 rounded-xl border border-slate-200 bg-white shadow-sm">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0 font-bold">
                    {idx + 1}
                  </div>
                  <span className="text-slate-700 leading-relaxed font-medium">{shorthand}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

import { Check } from 'lucide-react';

