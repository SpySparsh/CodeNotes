import { test, expect } from '@playwright/test';
import { authenticateTestUser, MOCK_NOTES, MOCK_NOTE_ID_1 } from './helpers';

test.describe('Note Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Authenticate user before testing generation flow
    await authenticateTestUser(page);
    // Navigate back to the home page where the generation input resides
    await page.goto('/');
  });

  test('should complete the async generation pipeline from 202 Accepted to note view', async ({ page }) => {
    const targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const mockIdempotencyKey = 'e2e-gen-key-success-123';
    let statusPollCount = 0;
    let postGenerateCount = 0;

    // 1. Intercept POST /api/generate
    await page.route('**/api/generate', async (route) => {
      if (route.request().method() === 'POST') {
        postGenerateCount++;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'pending',
            idempotencyKey: mockIdempotencyKey,
          }),
        });
      } else {
        await route.continue();
      }
    });

    // 2. Intercept GET /api/generate/status
    await page.route(`**/api/generate/status*`, async (route) => {
      statusPollCount++;
      if (statusPollCount === 1) {
        // First poll: processing
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'processing',
            videoTitle: 'Mastering React 19 Server Components',
          }),
        });
      } else {
        // Subsequent poll: completed
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'completed',
            noteId: MOCK_NOTE_ID_1,
            videoTitle: 'Mastering React 19 Server Components',
          }),
        });
      }
    });

    // 3. Intercept GET /api/notes/:id
    await page.route(`**/api/notes/${MOCK_NOTE_ID_1}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ note: MOCK_NOTES[0] }),
      });
    });

    // Fill URL input and submit
    const input = page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]');
    await expect(input).toBeVisible();
    await input.fill(targetUrl);

    const generateBtn = page.getByRole('button', { name: /Generate/i });
    await generateBtn.click();

    // Verify successful navigation to the generated note page
    await expect(page).toHaveURL(new RegExp(`/notes/${MOCK_NOTE_ID_1}`), { timeout: 15000 });

    // Verify note details are rendered accurately
    await expect(page.getByRole('heading', { level: 1, name: /Mastering React 19 Server Components/i })).toBeVisible();
    await expect(page.getByText(/A deep dive into React 19 Server Components/i)).toBeVisible();
    await expect(page.getByText(/React Server Components \(RSC\) Architecture/i)).toBeVisible();

    // Verify idempotency: Exactly 1 POST /api/generate was performed
    expect(postGenerateCount).toBe(1);
    expect(statusPollCount).toBeGreaterThanOrEqual(1);
  });

  test('should handle duplicate submission by immediately replaying cached completed note', async ({ page }) => {
    const targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    let postGenerateCount = 0;

    // 1. Intercept POST /api/generate returning 200 OK cache hit
    await page.route('**/api/generate', async (route) => {
      if (route.request().method() === 'POST') {
        postGenerateCount++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            status: 'completed',
            noteId: MOCK_NOTE_ID_1,
            cached: true,
          }),
        });
      } else {
        await route.continue();
      }
    });

    // 2. Intercept GET /api/notes/:id
    await page.route(`**/api/notes/${MOCK_NOTE_ID_1}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ note: MOCK_NOTES[0] }),
      });
    });

    // Fill URL input and submit duplicate video
    const input = page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]');
    await input.fill(targetUrl);
    await page.getByRole('button', { name: /Generate/i }).click();

    // Verify immediate redirect to note without polling
    await expect(page).toHaveURL(new RegExp(`/notes/${MOCK_NOTE_ID_1}`), { timeout: 15000 });
    await expect(page.getByRole('heading', { level: 1, name: /Mastering React 19 Server Components/i })).toBeVisible();
    expect(postGenerateCount).toBe(1);
  });

  test('should handle asynchronous generation failure gracefully', async ({ page }) => {
    const targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const mockIdempotencyKey = 'e2e-gen-key-failure-456';
    const errorMessage = 'No transcript captions available for this video.';

    // Intercept POST /api/generate
    await page.route('**/api/generate', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'pending',
          idempotencyKey: mockIdempotencyKey,
        }),
      });
    });

    // Intercept GET /api/generate/status returning failed status
    await page.route(`**/api/generate/status*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'failed',
          error: errorMessage,
        }),
      });
    });

    const input = page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]');
    await input.fill(targetUrl);
    await page.getByRole('button', { name: /Generate/i }).click();

    // Verify failure error message appears in UI (using first() or paragraph locator to avoid toast strict mode violation)
    await expect(page.locator('p.text-red-500')).toContainText(errorMessage, { timeout: 10000 });

    // Verify input is re-enabled for a new attempt
    await expect(page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]')).toBeEnabled();
  });

  test('should handle 429 rate limit error on submission', async ({ page }) => {
    const targetUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const rateLimitMessage = 'Too many generation requests. Please try again in 50 seconds.';

    // Intercept POST /api/generate returning 429
    await page.route('**/api/generate', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: rateLimitMessage,
        }),
      });
    });

    const input = page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]');
    await input.fill(targetUrl);
    await page.getByRole('button', { name: /Generate/i }).click();

    // Verify rate limit banner error
    await expect(page.getByText(rateLimitMessage)).toBeVisible();
  });

  test('should reject invalid YouTube URLs with client-side validation', async ({ page }) => {
    const input = page.locator('input[placeholder="Paste a YouTube coding tutorial URL..."]');
    await input.fill('https://not-youtube.com/watch?v=123');
    await page.getByRole('button', { name: /Generate/i }).click();

    await expect(page.getByText(/Please enter a valid YouTube video URL/i)).toBeVisible();
  });
});
