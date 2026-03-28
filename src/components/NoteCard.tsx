import Link from 'next/link';
import { Trash2, CalendarDays, ExternalLink } from 'lucide-react';

interface NoteCardProps {
  id: string;
  videoId: string;
  title: string;
  summary: string;
  thumbnailUrl?: string;
  createdAt?: string;
  onDelete: (id: string) => void;
}

export default function NoteCard({ id, title, summary, thumbnailUrl, createdAt, onDelete }: NoteCardProps) {
  const date = createdAt ? new Date(createdAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  }) : 'Just now';

  return (
    <div className="group relative flex flex-col bg-card/40 backdrop-blur-sm border border-border/50 rounded-2xl overflow-hidden hover:border-cyan-500/50 hover:shadow-xl hover:shadow-cyan-500/10 transition-all duration-300">
      <Link href={`/notes/${id}`} className="flex-1 flex flex-col z-10">
        {thumbnailUrl && (
          <div className="w-full h-48 overflow-hidden bg-gray-900 border-b border-border/50">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img 
              src={thumbnailUrl} 
              alt={title} 
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 opacity-90 group-hover:opacity-100"
            />
          </div>
        )}
        <div className="p-5 flex flex-col flex-1">
          <h3 className="font-semibold text-lg text-white mb-2 line-clamp-2 leading-tight group-hover:text-cyan-400 transition-colors">
            {title}
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-3 mb-4 flex-1">
            {summary}
          </p>
          <div className="flex items-center gap-2 text-xs text-gray-500 mt-auto">
            <CalendarDays size={14} />
            <span>{date}</span>
          </div>
        </div>
      </Link>
      
      <div className="absolute top-3 right-3 z-20 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(id);
          }}
          className="p-2 bg-black/60 hover:bg-red-500/80 text-white rounded-full backdrop-blur-md transition-colors shadow-lg"
          title="Delete Note"
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
