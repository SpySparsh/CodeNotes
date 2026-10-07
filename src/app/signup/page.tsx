'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createClient } from '@/lib/supabase/client';
import { Video, ArrowRight, Loader2, CheckCircle2 } from 'lucide-react';
import { signupSchema, SignupInput } from '@/lib/validations/auth';

function SignupForm() {
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [submittedEmail, setSubmittedEmail] = useState('');

  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') || '/library';

  const supabase = createClient();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  const handleSignup = async (data: SignupInput) => {
    setLoading(true);
    setError(null);
    setSubmittedEmail(data.email);

    try {
      const origin = window.location.origin;
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email: data.email,
        password: data.password,
        options: {
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });

      if (signUpError) {
        setError(signUpError.message);
        setLoading(false);
        return;
      }

      // If user session is returned immediately (email confirmation disabled):
      if (authData.session) {
        router.push(next);
        router.refresh();
        return;
      }

      // If Supabase requires email confirmation:
      if (authData.user && !authData.session) {
        setConfirmationSent(true);
        setLoading(false);
        return;
      }

      router.push(next);
    } catch (err: any) {
      setError(err?.message || 'An unexpected error occurred during signup.');
      setLoading(false);
    }
  };

  const handleGoogleSignup = async () => {
    setOauthLoading(true);
    setError(null);

    try {
      const origin = window.location.origin;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setOauthLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to initiate Google signup.');
      setOauthLoading(false);
    }
  };

  if (confirmationSent) {
    return (
      <div className="w-full max-w-md mx-auto px-4 py-16 flex flex-col justify-center min-h-[calc(100vh-8rem)]">
        <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-xl text-center">
          <div className="w-12 h-12 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 size={28} />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">Check your email</h2>
          <p className="text-slate-600 text-sm mb-6 leading-relaxed">
            We&apos;ve sent a confirmation link to <span className="font-semibold text-slate-800">{submittedEmail}</span>. Click the link in your email to activate your account.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center justify-center w-full px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold rounded-xl text-sm transition-colors"
          >
            Back to Sign In
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-md mx-auto px-4 py-16 flex flex-col justify-center min-h-[calc(100vh-8rem)]">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-tr from-purple-500 to-indigo-500 text-white shadow-lg shadow-purple-500/25 mb-4">
          <Video size={24} />
        </div>
        <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Create your account</h1>
        <p className="text-slate-500 mt-2 text-sm">Start generating structured notes from your favorite coding tutorials</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-xl shadow-slate-200/40">
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-100 text-red-600 text-sm font-medium">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleGoogleSignup}
          disabled={oauthLoading || loading}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-slate-200 rounded-xl bg-white hover:bg-slate-50 text-slate-700 font-semibold transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed mb-6 cursor-pointer"
        >
          {oauthLoading ? (
            <Loader2 size={18} className="animate-spin text-purple-600" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
          )}
          <span>Sign up with Google</span>
        </button>

        <div className="relative flex items-center justify-center mb-6">
          <div className="border-t border-slate-200 w-full" />
          <span className="bg-white px-4 text-xs font-semibold uppercase tracking-wider text-slate-400 absolute">
            or with email
          </span>
        </div>

        <form onSubmit={handleSubmit(handleSignup)} className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              {...register('email')}
              placeholder="you@example.com"
              className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-4 focus:ring-purple-100 focus:border-purple-400 transition-all text-sm"
            />
            {errors.email && (
              <p className="mt-1.5 text-xs text-red-500 font-medium">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              {...register('password')}
              placeholder="At least 6 characters"
              className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-4 focus:ring-purple-100 focus:border-purple-400 transition-all text-sm"
            />
            {errors.password && (
              <p className="mt-1.5 text-xs text-red-500 font-medium">{errors.password.message}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || oauthLoading}
            className="w-full mt-2 flex items-center justify-center gap-2 px-6 py-3.5 bg-primary hover:bg-purple-700 text-white font-semibold rounded-xl transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed text-sm cursor-pointer"
          >
            {loading ? (
              <Loader2 size={18} className="animate-spin" />
            ) : (
              <>
                Create Account <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>
      </div>

      <p className="text-center text-sm text-slate-500 mt-6 font-medium">
        Already have an account?{' '}
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-purple-600 font-semibold hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

export default function SignupPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-purple-600" /></div>}>
      <SignupForm />
    </Suspense>
  );
}
