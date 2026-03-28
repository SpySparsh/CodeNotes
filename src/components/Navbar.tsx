import Link from 'next/link';
import { BookOpen, Library, Video } from 'lucide-react';

export default function Navbar() {
  return (
    <nav className="border-b border-border/40 backdrop-blur-xl bg-background/80 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center gap-2 group">
            <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-500 text-white shadow-lg shadow-purple-500/20 group-hover:shadow-purple-500/40 transition-shadow">
              <Video size={18} />
            </div>
            <span className="font-extrabold text-xl tracking-tight text-slate-900">
              CodeNotes
              <span className="text-purple-600">.ai</span>
            </span>
          </Link>
          
          <div className="flex items-center gap-6">
            <Link 
              href="/library" 
              className="flex items-center gap-2 text-sm font-semibold text-slate-500 hover:text-purple-600 transition-colors"
            >
              <Library size={16} />
              Library
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
