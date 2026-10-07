'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Trash2, CalendarDays, Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

interface NoteCardProps {
  id: string;
  videoId: string;
  title: string;
  summary: string;
  thumbnailUrl?: string;
  createdAt?: string;
  viewMode?: 'grid' | 'list';
  onDelete: (id: string) => Promise<void> | void;
  isDeleting?: boolean;
}

export default function NoteCard({
  id,
  title,
  summary,
  thumbnailUrl,
  createdAt,
  viewMode = 'grid',
  onDelete,
  isDeleting = false,
}: NoteCardProps) {
  const [open, setOpen] = useState(false);
  const date = createdAt
    ? new Date(createdAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Just now';

  if (viewMode === 'list') {
    return (
      <div className="group relative flex flex-col sm:flex-row items-stretch bg-white border border-slate-200 rounded-2xl overflow-hidden hover:border-purple-300 hover:shadow-lg transition-all duration-300">
        <Link href={`/notes/${id}`} className="flex flex-col sm:flex-row flex-1 z-10">
          {thumbnailUrl && (
            <div className="w-full sm:w-56 h-36 shrink-0 overflow-hidden bg-slate-900 border-b sm:border-b-0 sm:border-r border-slate-100">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbnailUrl}
                alt={title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-95"
              />
            </div>
          )}
          <div className="p-5 flex flex-col justify-between flex-1 min-w-0">
            <div>
              <h3 className="font-bold text-lg text-slate-900 mb-1.5 line-clamp-1 group-hover:text-purple-600 transition-colors">
                {title}
              </h3>
              <p className="text-sm text-slate-600 line-clamp-2 leading-relaxed mb-3">
                {summary}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
              <CalendarDays size={14} />
              <span>{date}</span>
            </div>
          </div>
        </Link>

        <div className="flex sm:flex-col items-center justify-center p-3 sm:pr-4 sm:border-l border-slate-100 z-20">
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                disabled={isDeleting}
                className="p-2.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors disabled:opacity-50 cursor-pointer"
                title="Delete Note"
              >
                {isDeleting ? (
                  <Loader2 size={18} className="animate-spin text-red-500" />
                ) : (
                  <Trash2 size={18} />
                )}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Note</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete &ldquo;{title}&rdquo;? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setOpen(false);
                    onDelete(id);
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative flex flex-col bg-white border border-slate-200 rounded-3xl overflow-hidden hover:border-purple-300 hover:shadow-xl hover:shadow-purple-500/5 transition-all duration-300">
      <Link href={`/notes/${id}`} className="flex-1 flex flex-col z-10">
        {thumbnailUrl && (
          <div className="w-full h-48 overflow-hidden bg-slate-900 border-b border-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt={title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-95 group-hover:opacity-100"
            />
          </div>
        )}
        <div className="p-6 flex flex-col flex-1">
          <h3 className="font-bold text-lg text-slate-900 mb-2 line-clamp-2 leading-snug group-hover:text-purple-600 transition-colors">
            {title}
          </h3>
          <p className="text-sm text-slate-600 line-clamp-3 mb-4 flex-1 leading-relaxed">
            {summary}
          </p>
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400 mt-auto">
            <CalendarDays size={14} />
            <span>{date}</span>
          </div>
        </div>
      </Link>

      <div className="absolute top-3 right-3 z-20">
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              disabled={isDeleting}
              className={cn(
                'p-2 bg-white/90 hover:bg-red-50 text-slate-600 hover:text-red-600 rounded-full backdrop-blur-md transition-all shadow-md opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer',
                isDeleting && 'opacity-100'
              )}
              title="Delete Note"
            >
              {isDeleting ? (
                <Loader2 size={16} className="animate-spin text-red-500" />
              ) : (
                <Trash2 size={16} />
              )}
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Note</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete &ldquo;{title}&rdquo;? This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setOpen(false);
                  onDelete(id);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
