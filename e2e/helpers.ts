import { Page } from '@playwright/test';

export const TEST_USER_EMAIL = process.env.E2E_USER_EMAIL;
export const TEST_USER_PASSWORD = process.env.E2E_USER_PASSWORD;

export const MOCK_NOTE_ID_1 = '550e8400-e29b-41d4-a716-446655440001';
export const MOCK_NOTE_ID_2 = '550e8400-e29b-41d4-a716-446655440002';

/**
 * Perform login via UI for authenticated test flows
 */
export async function loginViaUi(page: Page) {
  if (!TEST_USER_EMAIL || !TEST_USER_PASSWORD) {
    throw new Error(
      'E2E_USER_EMAIL and E2E_USER_PASSWORD environment variables are required to perform loginViaUi.'
    );
  }
  await page.goto('/login');
  await page.locator('input#email').fill(TEST_USER_EMAIL);
  await page.locator('input#password').fill(TEST_USER_PASSWORD);
  await page.getByRole('button', { name: /Sign in/i }).click();
  await page.waitForURL(/\/library/, { timeout: 15000 });
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
