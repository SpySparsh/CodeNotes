import { test, expect } from '@playwright/test';
import { authenticateTestUser, MOCK_NOTES, MOCK_NOTE_ID_1, MOCK_USER_B_ID, MOCK_USER_B_EMAIL } from './helpers';

test.describe('Study Library & Note Management', () => {
  test.beforeEach(async ({ page }) => {
    await authenticateTestUser(page);
  });

  test('should render empty library state when no notes exist', async ({ page }) => {
    await page.route(/\/api\/notes/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          notes: [],
          nextCursor: null,
          hasMore: false,
        }),
      });
    });

    await page.goto('/library');

    await expect(page.getByRole('heading', { level: 1, name: /Your Study Library/i })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: /Your library is empty/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Generate Your First Note/i })).toBeVisible();
  });

  test('should render list of note cards with titles and overviews', async ({ page }) => {
    await page.route(/\/api\/notes/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          notes: MOCK_NOTES,
          nextCursor: null,
          hasMore: false,
        }),
      });
    });

    await page.goto('/library');

    await expect(page.getByRole('heading', { level: 1, name: /Your Study Library/i })).toBeVisible();
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();
    await expect(page.getByText('PostgreSQL Indexing and Query Performance')).toBeVisible();
    await expect(page.getByText(/A deep dive into React 19 Server Components/i)).toBeVisible();
  });

  test('should filter notes via search input', async ({ page }) => {
    let capturedSearchQuery = '';

    await page.route(/\/api\/notes/, async (route) => {
      const url = new URL(route.request().url());
      capturedSearchQuery = url.searchParams.get('search') || '';

      const filtered = MOCK_NOTES.filter(
        (n) =>
          n.videoTitle.toLowerCase().includes(capturedSearchQuery.toLowerCase()) ||
          n.overview.toLowerCase().includes(capturedSearchQuery.toLowerCase())
      );

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          notes: filtered,
          nextCursor: null,
          hasMore: false,
        }),
      });
    });

    await page.goto('/library');
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();

    // Type search query
    const searchInput = page.locator('input[placeholder="Search notes by title or overview..."]');
    await searchInput.fill('PostgreSQL');

    // Wait for debounced search request and filtered view
    await expect.poll(() => capturedSearchQuery).toBe('PostgreSQL');
    await expect(page.getByText('PostgreSQL Indexing and Query Performance')).toBeVisible();
    await expect(page.getByText('Mastering React 19 Server Components')).not.toBeVisible();

    // Clear search and verify original notes are restored from TanStack Query cache
    await searchInput.fill('');
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();
    await expect(page.getByText('PostgreSQL Indexing and Query Performance')).toBeVisible();
  });

  test('should trigger sort parameter changes', async ({ page }) => {
    let capturedSortOrder = '';
    let capturedSortField = '';

    await page.route(/\/api\/notes/, async (route) => {
      const url = new URL(route.request().url());
      capturedSortField = url.searchParams.get('sort') || '';
      capturedSortOrder = url.searchParams.get('order') || '';

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          notes: MOCK_NOTES,
          nextCursor: null,
          hasMore: false,
        }),
      });
    });

    await page.goto('/library');
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();

    // Select sort dropdown
    const sortTrigger = page.locator('button[role="combobox"]');
    await sortTrigger.click();

    // Pick "Oldest First"
    await page.getByRole('option', { name: 'Oldest First' }).click();

    await expect.poll(() => capturedSortOrder).toBe('asc');
    expect(capturedSortField).toBe('created_at');
  });

  test('should navigate to note details when clicking a note card', async ({ page }) => {
    await page.route(/\/api\/notes/, async (route) => {
      const url = route.request().url();
      if (url.includes(`/api/notes/${MOCK_NOTE_ID_1}`)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            note: MOCK_NOTES[0],
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            notes: MOCK_NOTES,
            nextCursor: null,
            hasMore: false,
          }),
        });
      }
    });

    await page.goto('/library');
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();

    // Click note card heading
    await page.getByRole('heading', { name: 'Mastering React 19 Server Components' }).click();

    await expect(page).toHaveURL(new RegExp(`/notes/${MOCK_NOTE_ID_1}`), { timeout: 15000 });
    await expect(page.getByRole('heading', { level: 1, name: /Mastering React 19 Server Components/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Back to Library')).toBeVisible();
  });

  test('should delete a note with AlertDialog confirmation', async ({ page }) => {
    let deleteCalled = false;
    let currentNotes = [...MOCK_NOTES];

    await page.route(/\/api\/notes/, async (route) => {
      const request = route.request();
      if (request.method() === 'DELETE' && request.url().includes(MOCK_NOTE_ID_1)) {
        deleteCalled = true;
        currentNotes = currentNotes.filter((n) => n.id !== MOCK_NOTE_ID_1);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            notes: currentNotes,
            nextCursor: null,
            hasMore: false,
          }),
        });
      }
    });

    await page.goto('/library');
    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();

    // Click delete button on card
    const deleteBtn = page.getByTitle('Delete Note').first();
    await deleteBtn.click({ force: true });

    // Verify AlertDialog
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Delete Note' })).toBeVisible();
    await expect(page.getByText(/Are you sure you want to delete/i)).toBeVisible();

    // Test Cancel first
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).not.toBeVisible();
    expect(deleteCalled).toBe(false);

    // Click delete again and confirm via action button
    await deleteBtn.click({ force: true });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect.poll(() => deleteCalled).toBe(true);
    await expect(page.getByText(/Note deleted successfully/i)).toBeVisible();
  });

  test('should display error alert and retry button when fetching notes fails', async ({ page }) => {
    let returnError = true;

    await page.route(/\/api\/notes/, async (route) => {
      if (returnError) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Database connection failed' }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            notes: MOCK_NOTES,
            nextCursor: null,
            hasMore: false,
          }),
        });
      }
    });

    await page.goto('/library');

    await expect(page.getByRole('heading', { level: 3, name: /Failed to load library/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Try Again/i })).toBeVisible();

    // Disable error and click retry
    returnError = false;
    await page.getByRole('button', { name: /Try Again/i }).click();

    await expect(page.getByText('Mastering React 19 Server Components')).toBeVisible();
  });

  test('should enforce user isolation: User B is denied access when navigating to User A note', async ({ page }) => {
    // Authenticate as User B
    await authenticateTestUser(page, { userId: MOCK_USER_B_ID, email: MOCK_USER_B_EMAIL });

    // Mock API returning 404 for User A's note
    await page.route(`**/api/notes/${MOCK_NOTE_ID_1}`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Note not found' }),
      });
    });

    // Mock User B's library returning empty notes list
    await page.route(/\/api\/notes(?!\/)/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          notes: [],
          nextCursor: null,
          hasMore: false,
        }),
      });
    });

    // User B attempts to access User A's note directly
    await page.goto(`/notes/${MOCK_NOTE_ID_1}`);

    // Verify error state
    await expect(page.getByRole('heading', { name: 'Error Loading Note' })).toBeVisible();
    await expect(page.getByText('Note not found')).toBeVisible();

    // Click Return to Library
    await page.getByRole('link', { name: 'Return to Library' }).click();
    await expect(page).toHaveURL(/\/library/);
    await expect(page.getByRole('heading', { level: 3, name: /Your library is empty/i })).toBeVisible();
    await expect(page.getByText('Mastering React 19 Server Components')).not.toBeVisible();
  });
});
