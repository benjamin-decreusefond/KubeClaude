import { expect, test as setup } from '@playwright/test';
import { PASSWORD, USERNAME } from './tests/fixtures';

/**
 * First-run setup, done through the UI because it is also a test of it: this
 * screen is the only thing a fresh instance shows, and it is the one screen
 * nobody sees twice.
 *
 * Everything else in the suite depends on this project, so it runs first and
 * exactly once per server.
 */
setup('an instance asks for a password before it shows anything', async ({ page }) => {
  await page.goto('/');

  // Exact: the static-token hint further down the card mentions the phrase too.
  await expect(page.getByText('Set a password', { exact: true })).toBeVisible();
  // Nothing of the app itself is reachable yet.
  await expect(page.locator('.nav')).toHaveCount(0);

  const submit = page.getByRole('button', { name: 'Set password' });
  await expect(submit).toBeDisabled();

  await page.getByLabel('Username', { exact: true }).fill(USERNAME);
  await page.getByLabel('Password', { exact: true }).fill('short');
  await expect(page.getByText('Too short — at least 8 characters.')).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill('something-else');
  await expect(page.getByText('The two do not match.')).toBeVisible();
  await expect(submit).toBeDisabled();

  await page.getByLabel('Confirm password').fill(PASSWORD);
  await expect(submit).toBeEnabled();
  await submit.click();

  // The API key is shown once, and only once.
  await expect(page.getByText('You are set up')).toBeVisible();
  expect((await page.locator('.mono-block').innerText()).trim().length).toBeGreaterThan(20);

  await page.getByRole('button', { name: 'Open KubeClaude' }).click();
  await expect(page.locator('.nav')).toBeVisible();
  await expect(page.getByText(`Signed in as ${USERNAME}`)).toBeVisible();
});
