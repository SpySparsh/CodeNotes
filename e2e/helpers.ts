import { Page } from '@playwright/test';

export const TEST_USER_EMAIL = process.env.E2E_USER_EMAIL;
export const TEST_USER_PASSWORD = process.env.E2E_USER_PASSWORD;

export const MOCK_USER_ID = 'ba7d21ff-8535-4c92-ab4d-e8f37b17ac4d';
export const MOCK_USER_EMAIL = 'e2e-user@example.com';
export const MOCK_NOTE_ID_1 = '550e8400-e29b-41d4-a716-446655440001';
export const MOCK_NOTE_ID_2 = '550e8400-e29b-41d4-a716-446655440002';

export const MOCK_USER = {
  id: MOCK_USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: MOCK_USER_EMAIL,
  email_confirmed_at: '2026-01-01T00:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: { name: 'E2E Test User' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

/**
 * Determine the Supabase auth cookie storage key based on configured Supabase URL
 */
export function getSupabaseCookieName(supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321'): string {
  try {
    const hostname = new URL(supabaseUrl).hostname;
    const projectRef = hostname.split('.')[0];
    return `sb-${projectRef}-auth-token`;
  } catch {
    return 'sb-127-auth-token';
  }
}

/**
 * Create base64url encoded Supabase SSR auth token value
 */
export function createMockSessionCookieValue(options: {
  userId?: string;
  email?: string;
  token?: string;
} = {}): string {
  const userId = options.userId || MOCK_USER_ID;
  const email = options.email || MOCK_USER_EMAIL;
  const token = options.token || 'mock-e2e-access-token';

  const sessionData = {
    access_token: token,
    refresh_token: 'mock-e2e-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600 * 24,
    expires_in: 3600 * 24,
    token_type: 'bearer',
    user: {
      id: userId,
      aud: 'authenticated',
      role: 'authenticated',
      email,
      email_confirmed_at: '2026-01-01T00:00:00.000Z',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { name: 'E2E Test User' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };

  return `base64-${Buffer.from(JSON.stringify(sessionData), 'utf8').toString('base64url')}`;
}

/**
 * Establish deterministic authenticated test state for a page
 */
export async function authenticateTestUser(page: Page, options: { userId?: string; email?: string } = {}) {
  const cookieName = getSupabaseCookieName();
  const cookieValue = createMockSessionCookieValue(options);

  // Set auth cookie in browser context
  await page.context().addCookies([
    {
      name: cookieName,
      value: cookieValue,
      domain: 'localhost',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
    {
      name: cookieName,
      value: cookieValue,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    },
  ]);

  // Intercept browser-side Supabase Auth API calls
  await page.route('**/auth/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_USER),
      });
    } else if (url.includes('/auth/v1/token')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1893456000,
          refresh_token: 'mock-e2e-refresh-token',
          user: MOCK_USER,
        }),
      });
    } else if (url.includes('/auth/v1/logout')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    } else {
      await route.continue();
    }
  });
}

/**
 * Perform login via UI for authenticated test flows (supports both live credentials and deterministic mock fallback)
 */
export async function loginViaUi(page: Page) {
  if (TEST_USER_EMAIL && TEST_USER_PASSWORD) {
    await page.goto('/login');
    await page.locator('input#email').fill(TEST_USER_EMAIL);
    await page.locator('input#password').fill(TEST_USER_PASSWORD);
    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/\/library/, { timeout: 15000 });
  } else {
    // Intercept auth token response for deterministic UI login
    await page.route('**/auth/v1/token*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'mock-e2e-access-token',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: 1893456000,
          refresh_token: 'mock-e2e-refresh-token',
          user: MOCK_USER,
        }),
      });
    });

    // Also set cookie so subsequent server-side page loads authenticate immediately
    await authenticateTestUser(page);

    await page.goto('/login');
    await page.locator('input#email').fill(MOCK_USER_EMAIL);
    await page.locator('input#password').fill('MockPassword123!');
    await page.getByRole('button', { name: /Sign in/i }).click();
    await page.waitForURL(/\/library/, { timeout: 15000 });
  }
}

/**
 * Mock note data fixture with valid UUIDs for deterministic testing
 */
export const MOCK_NOTES = [
  {
    id: MOCK_NOTE_ID_1,
    userId: 'ba7d21ff-8535-4c92-ab4d-e8f37b17ac4d',
    videoId: 'dQw4w9WgXcQ',
    videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    videoTitle: 'Mastering React 19 Server Components',
    thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    overview:
      'A deep dive into React 19 Server Components, Actions, and compiler optimizations for modern full-stack web applications.',
    keyConcepts: [
      'React Server Components (RSC) Architecture',
      'Server Actions and Form Handling',
      'useOptimistic and useActionState Hooks',
      'Automatic Memoization with React Compiler',
    ],
    detailedNotes:
      '# React 19 Server Components\n\nReact 19 introduces major updates to the server rendering paradigm.\n\n```typescript\nasync function ServerComponent() {\n  const data = await fetchData();\n  return <div>{data.title}</div>;\n}\n```\n\n| Feature | React 18 | React 19 |\n|---|---|---|\n| Compiler | Babel/SWC plugins | React Compiler |\n| Actions | Manual fetch | Server Actions |',
    shorthands: [
      'Use useActionState for form pending states',
      'Pass server actions directly to <form action={...}>',
      'Use useOptimistic for immediate UI updates before server response',
    ],
    createdAt: new Date('2026-03-01T10:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-03-01T10:00:00.000Z').toISOString(),
  },
  {
    id: MOCK_NOTE_ID_2,
    userId: 'ba7d21ff-8535-4c92-ab4d-e8f37b17ac4d',
    videoId: 'kXYiU_JCYtU',
    videoUrl: 'https://www.youtube.com/watch?v=kXYiU_JCYtU',
    videoTitle: 'PostgreSQL Indexing and Query Performance',
    thumbnailUrl: 'https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg',
    overview:
      'Learn B-Tree, BRIN, and GIN indexing strategies to scale relational database queries to millions of records efficiently.',
    keyConcepts: [
      'B-Tree vs Hash vs GIN Indexes',
      'EXPLAIN ANALYZE Execution Plans',
      'Composite Index Column Ordering',
      'Cursor Keyset Pagination over Offset',
    ],
    detailedNotes:
      '# PostgreSQL Indexing\n\nOptimizing database queries requires deep understanding of index selection and execution plans.\n\n```sql\nCREATE INDEX idx_notes_created_at_id ON notes(created_at DESC, id DESC);\n```',
    shorthands: [
      'Always order composite index columns from highest to lowest selectivity',
      'Use Keyset pagination with (created_at, id) for O(1) page traversal',
    ],
    createdAt: new Date('2026-02-15T08:30:00.000Z').toISOString(),
    updatedAt: new Date('2026-02-15T08:30:00.000Z').toISOString(),
  },
];
