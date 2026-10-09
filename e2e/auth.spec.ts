import { test, expect } from '@playwright/test';

test.describe('Authentication & Route Protection', () => {
  test('should render the login page with all expected elements', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();
    await expect(page.getByText(/Sign in to your CodeNotes account/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with Google/i })).toBeVisible();
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign in/i })).toBeVisible();
    // Scope link inside form/footer to avoid ambiguity with navbar
    await expect(page.locator('p').getByRole('link', { name: /Sign up/i })).toBeVisible();
  });

  test('should show client-side validation errors for invalid input on login', async ({ page }) => {
    await page.goto('/login');

    // Submit empty fields
    await page.getByRole('button', { name: /Sign in/i }).click();

    await expect(page.getByText(/Email is required/i)).toBeVisible();
    await expect(page.getByText(/Password is required/i)).toBeVisible();
  });

  test('should render the signup page and validate minimum password length', async ({ page }) => {
    await page.goto('/signup');

    await expect(page.getByRole('heading', { name: /Create your account/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Sign up with Google/i })).toBeVisible();
    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();

    // Input short password
    await page.locator('input#email').fill('newdeveloper@example.com');
    await page.locator('input#password').fill('12345');
    await page.getByRole('button', { name: /Create Account/i }).click();

    await expect(page.getByText(/Password must be at least 6 characters/i)).toBeVisible();
  });

  test('should redirect unauthenticated users from protected page /library to /login', async ({ page }) => {
    await page.goto('/library');
    await expect(page).toHaveURL(/\/login\?next=%2Flibrary/);
  });

  test('should redirect unauthenticated users from protected page /notes/[id] to /login', async ({ page }) => {
    const fakeNoteId = '550e8400-e29b-41d4-a716-446655440000';
    await page.goto(`/notes/${fakeNoteId}`);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Fnotes%2F${fakeNoteId}`));
  });

  test('should return 401 Unauthorized for direct unauthenticated API access', async ({ request }) => {
    const notesResponse = await request.get('/api/notes');
    expect(notesResponse.status()).toBe(401);

    const generateResponse = await request.post('/api/generate', {
      data: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    expect(generateResponse.status()).toBe(401);
  });
});
