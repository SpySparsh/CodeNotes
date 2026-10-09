import { test, expect } from '@playwright/test';
import { TEST_USER_EMAIL, TEST_USER_PASSWORD } from './helpers';

test.describe('Live Authentication Smoke Test (Opt-In)', () => {
  test('should perform live Supabase authentication lifecycle (login -> verify session -> logout)', async ({ page }) => {
    test.skip(
      !TEST_USER_EMAIL || !TEST_USER_PASSWORD,
      'Skipping live authentication smoke test: E2E_USER_EMAIL and E2E_USER_PASSWORD environment variables are not configured.'
    );

    await page.goto('/login');
    await page.locator('input#email').fill(TEST_USER_EMAIL!);
    await page.locator('input#password').fill(TEST_USER_PASSWORD!);
    await page.getByRole('button', { name: /Sign in/i }).click();

    // After login, should redirect to /library
    await expect(page).toHaveURL(/\/library/, { timeout: 15000 });
    await expect(page.getByRole('button', { name: /Sign out/i })).toBeVisible();

    // Perform sign out
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page.getByRole('link', { name: /Sign in/i })).toBeVisible({ timeout: 10000 });
  });
});
