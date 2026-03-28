'use client';

import { useEffect, useState } from 'react';
import NoteCard from '@/components/NoteCard';
import { BookOpen } from 'lucide-react';
import { Note } from '@/lib/db';

export default function LibraryPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchNotes();
  }, []);

  const fetchNotes = async () => {
    try {
      const res = await fetch('/api/notes');
      const data = await res.json();
      if (data.success) {
        setNotes(data.notes);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this note?')) return;
    
    // Optimistic UI update
    setNotes(notes.filter(n => n.id !== id));
    
    try {
      await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error(e);
      // Revert on failure
      fetchNotes();
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex items-center gap-4 mb-10 pb-6 border-b border-slate-200">
        <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600 border border-purple-100">
          <BookOpen size={24} />
        </div>
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900">Your Study Library</h1>
          <p className="text-slate-500 mt-1 font-medium">Review your generated tech notes and code snippets.</p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-72 bg-slate-100 rounded-2xl animate-pulse"></div>
          ))}
        </div>
      ) : notes.length === 0 ? (
        <div className="text-center py-24 border border-dashed border-slate-300 rounded-3xl bg-slate-50">
          <BookOpen size={48} className="mx-auto text-slate-400 mb-4 opacity-70" />
          <h3 className="text-xl font-bold text-slate-900 mb-2">Your library is empty</h3>
          <p className="text-slate-600 max-w-md mx-auto font-medium">
            Head over to the home page and paste a YouTube URL to generate your first set of notes.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {notes.map((note) => (
            <NoteCard
              key={note.id}
              id={note.id}
              videoId={note.videoId}
              title={note.videoTitle}
              summary={note.overview}
              thumbnailUrl={note.thumbnailUrl}
              createdAt={note.createdAt}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
