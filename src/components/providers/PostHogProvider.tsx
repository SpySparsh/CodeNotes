'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { initPostHog, capturePageView, isPostHogEnabled } from '@/lib/analytics';

interface PostHogProviderProps {
  children: React.ReactNode;
}

export default function PostHogProvider({ children }: PostHogProviderProps) {
  const pathname = usePathname();
  const lastTrackedRouteRef = useRef<string | null>(null);

  useEffect(() => {
    initPostHog();
  }, []);

  useEffect(() => {
    if (!isPostHogEnabled() || !pathname) {
      return;
    }

    if (lastTrackedRouteRef.current === pathname) {
      return;
    }

    lastTrackedRouteRef.current = pathname;
    capturePageView(pathname);
  }, [pathname]);

  return <>{children}</>;
}
