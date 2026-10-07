'use client';

import { useState, useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import NoteCard from '@/components/NoteCard';
import {
  BookOpen,
  Search,
  LayoutGrid,
  List,
  SlidersHorizontal,
  Loader2,
  X,
  PlusCircle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { useNotesInfiniteQuery, useDeleteNoteMutation } from '@/lib/queries/useNotes';
import { useLibraryStore } from '@/lib/stores/useLibraryStore';
import { SortField, SortOrder } from '@/lib/validations/notes';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import Link from 'next/link';

export default function LibraryPage() {
  const router = useRouter();
  const { viewMode, setViewMode } = useLibraryStore();

  // Local search input state with debouncing
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortOption, setSortOption] = useState<'created_at_desc' | 'created_at_asc' | 'title_asc' | 'title_desc'>('created_at_desc');

  // Debounce search query by 300ms
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearch(searchInput);
    }, 300);
    return () => clearTimeout(handler);
  }, [searchInput]);

  // Parse sort field and order from selection
  let sortField: SortField = 'created_at';
  let sortOrder: SortOrder = 'desc';

  if (sortOption === 'created_at_asc') {
    sortField = 'created_at';
    sortOrder = 'asc';
  } else if (sortOption === 'title_asc') {
    sortField = 'video_title';
    sortOrder = 'asc';
  } else if (sortOption === 'title_desc') {
    sortField = 'video_title';
    sortOrder = 'desc';
  }

  // TanStack Query Infinite Query
  const {
    data,
    error,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useNotesInfiniteQuery({
    search: debouncedSearch,
    sort: sortField,
    order: sortOrder,
    limit: 20,
  });

  const deleteMutation = useDeleteNoteMutation();

  // Handle unauthorized redirect
  useEffect(() => {
    if (isError && (error as any)?.status === 401) {
      router.push('/login?next=/library');
    }
  }, [isError, error, router]);

  // Infinite scroll intersection observer
  const observerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = observerRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          fetchNextPage();
        }
      },
      { rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Flatten all note items across pages
  const allNotes = data?.pages.flatMap((page) => page.notes) ?? [];

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
      toast.success('Note deleted successfully');
    } catch (err: any) {
      if (err?.status === 401) {
        router.push('/login?next=/library');
        return;
      }
      toast.error(err?.message || 'Failed to delete note');
    }
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8 pb-6 border-b border-slate-200">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center text-white shadow-lg shadow-purple-500/20">
            <BookOpen size={24} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Your Study Library</h1>
            <p className="text-slate-500 text-sm mt-0.5 font-medium">
              Review and search your generated tech notes and code summaries
            </p>
          </div>
        </div>

        <Link href="/">
          <Button className="flex items-center gap-2 bg-primary hover:bg-purple-700 text-white rounded-xl shadow-md">
            <PlusCircle size={18} />
            <span>Generate New Note</span>
          </Button>
        </Link>
      </div>

      {/* Toolbar: Search, Sort, ViewMode */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 mb-8 bg-white p-3 rounded-2xl border border-slate-200 shadow-sm">
        {/* Search input */}
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 h-4 w-4" />
          <Input
            type="text"
            placeholder="Search notes by title or overview..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10 pr-9 border-none bg-slate-50 focus:bg-white text-sm rounded-xl h-10 shadow-none focus:ring-2 focus:ring-purple-100"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded-full"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Sort and View controls */}
        <div className="flex items-center gap-2.5">
          <div className="w-44">
            <Select
              value={sortOption}
              onValueChange={(val: any) => setSortOption(val)}
            >
              <SelectTrigger className="h-10 text-xs bg-slate-50 border-none font-medium">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created_at_desc">Newest First</SelectItem>
                <SelectItem value="created_at_asc">Oldest First</SelectItem>
                <SelectItem value="title_asc">Title (A to Z)</SelectItem>
                <SelectItem value="title_desc">Title (Z to A)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200/50">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'grid'
                  ? 'bg-white text-purple-600 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="Grid View"
            >
              <LayoutGrid size={16} />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg transition-all ${
                viewMode === 'list'
                  ? 'bg-white text-purple-600 shadow-xs'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
              title="List View"
            >
              <List size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      {isLoading ? (
        <div
          className={
            viewMode === 'grid'
              ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6'
              : 'flex flex-col gap-4'
          }
        >
          {Array.from({ length: 8 }).map((_, idx) => (
            <div
              key={idx}
              className={`bg-white border border-slate-200 rounded-3xl p-5 ${
                viewMode === 'list' ? 'h-36 flex gap-4' : 'h-80 flex flex-col'
              }`}
            >
              <Skeleton className={viewMode === 'list' ? 'w-48 h-full rounded-2xl shrink-0' : 'w-full h-44 rounded-2xl mb-4'} />
              <div className="flex-1 space-y-3">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="text-center py-20 bg-red-50/50 border border-red-100 rounded-3xl p-8 max-w-md mx-auto">
          <AlertCircle className="mx-auto text-red-500 h-10 w-10 mb-3" />
          <h3 className="text-lg font-bold text-slate-900 mb-1">Failed to load library</h3>
          <p className="text-slate-600 text-sm mb-6">
            {error?.message || 'An unexpected error occurred while fetching your notes.'}
          </p>
          <Button
            onClick={() => refetch()}
            variant="outline"
            className="flex items-center gap-2 mx-auto"
          >
            <RefreshCw size={14} />
            <span>Try Again</span>
          </Button>
        </div>
      ) : allNotes.length === 0 ? (
        debouncedSearch ? (
          /* Empty search results */
          <div className="text-center py-20 border border-dashed border-slate-300 rounded-3xl bg-slate-50/50 max-w-lg mx-auto">
            <Search size={40} className="mx-auto text-slate-400 mb-3 opacity-60" />
            <h3 className="text-lg font-bold text-slate-900 mb-1">No matching notes found</h3>
            <p className="text-slate-500 text-sm max-w-xs mx-auto mb-6">
              No notes match &ldquo;{debouncedSearch}&rdquo;. Try checking for typos or using different keywords.
            </p>
            <Button
              onClick={() => setSearchInput('')}
              variant="outline"
              size="sm"
            >
              Clear Search
            </Button>
          </div>
        ) : (
          /* Empty library state */
          <div className="text-center py-24 border border-dashed border-slate-300 rounded-3xl bg-slate-50/50 max-w-xl mx-auto">
            <div className="w-16 h-16 bg-purple-50 text-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-purple-100">
              <BookOpen size={28} />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Your library is empty</h3>
            <p className="text-slate-600 text-sm max-w-md mx-auto mb-8 leading-relaxed font-medium">
              Start generating AI-powered tech notes and code snippets from any YouTube coding tutorial.
            </p>
            <Link href="/">
              <Button className="bg-primary hover:bg-purple-700 text-white rounded-xl shadow-md">
                Generate Your First Note
              </Button>
            </Link>
          </div>
        )
      ) : (
        <>
          {/* Notes Grid / List */}
          <div
            className={
              viewMode === 'grid'
                ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6'
                : 'flex flex-col gap-4'
            }
          >
            {allNotes.map((note) => (
              <NoteCard
                key={note.id}
                id={note.id}
                videoId={note.videoId}
                title={note.videoTitle}
                summary={note.overview}
                thumbnailUrl={note.thumbnailUrl}
                createdAt={note.createdAt}
                viewMode={viewMode}
                onDelete={handleDelete}
                isDeleting={deleteMutation.isPending && deleteMutation.variables === note.id}
              />
            ))}
          </div>

          {/* Infinite scroll sentinel and status */}
          <div ref={observerRef} className="py-12 flex items-center justify-center">
            {isFetchingNextPage ? (
              <div className="flex items-center gap-3 text-slate-500 font-medium text-sm">
                <Loader2 size={18} className="animate-spin text-purple-600" />
                <span>Loading more notes...</span>
              </div>
            ) : hasNextPage ? (
              <Button
                onClick={() => fetchNextPage()}
                variant="outline"
                size="sm"
                className="text-slate-600 font-medium"
              >
                Load More Notes
              </Button>
            ) : allNotes.length > 20 ? (
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                All notes loaded
              </span>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
