'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Library, Video, LogOut, User as UserIcon } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { User } from '@supabase/supabase-js';

export default function Navbar() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    const getUser = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        setUser(user);
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [supabase]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setUser(null);
    router.push('/');
    router.refresh();
  };

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

          <div className="flex items-center gap-4 sm:gap-6">
            {!loading && user ? (
              <>
                <Link
                  href="/library"
                  className="flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-purple-600 transition-colors"
                >
                  <Library size={16} />
                  <span>Library</span>
                </Link>

                <div className="flex items-center gap-3 pl-2 sm:pl-4 border-l border-slate-200">
                  <div className="hidden sm:flex items-center gap-2 text-xs font-medium text-slate-500 bg-slate-100 px-3 py-1.5 rounded-full max-w-[200px] truncate">
                    <UserIcon size={14} className="text-slate-400 shrink-0" />
                    <span className="truncate">{user.email}</span>
                  </div>

                  <button
                    onClick={handleSignOut}
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-red-600 transition-colors py-1.5 px-2 rounded-lg hover:bg-red-50"
                    title="Sign out"
                  >
                    <LogOut size={16} />
                    <span className="hidden sm:inline">Sign out</span>
                  </button>
                </div>
              </>
            ) : !loading ? (
              <div className="flex items-center gap-3">
                <Link
                  href="/login"
                  className="text-sm font-semibold text-slate-600 hover:text-purple-600 transition-colors px-3 py-1.5"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="text-sm font-semibold text-white bg-primary hover:bg-purple-700 px-4 py-2 rounded-xl transition-all shadow-sm"
                >
                  Sign up
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </nav>
  );
}
