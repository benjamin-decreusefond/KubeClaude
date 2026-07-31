import { expect, expectNoPageErrors, test, PASSWORD, USERNAME } from './fixtures';

/**
 * Settings and the security section. This file runs last by name, because
 * signing out and rotating credentials is exactly the sort of thing that would
 * pull the rug from under another spec's session.
 */
test.describe.configure({ mode: 'serial' });

test('a setting is saved and survives a reload', async ({ page, consoleErrors }) => {
  await page.goto('/settings');

  await page.getByLabel('Session token budget').fill('500000');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Session token budget')).toHaveValue('500000');

  // Put it back, so the quota gauges do not change what later runs see.
  await page.getByLabel('Session token budget').fill('0');
  await page.getByRole('button', { name: 'Save settings' }).click();
  expectNoPageErrors(consoleErrors);
});

test('the security section reports how this instance is protected', async ({ page, consoleErrors }) => {
  await page.goto('/settings');

  await expect(page.getByText('Security', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Authentication', { exact: true })).toHaveValue('forms');
  await expect(page.getByText(`Signed in as ${USERNAME}`).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('turning authentication off warns about what that means', async ({ page, consoleErrors }) => {
  await page.goto('/settings');

  await page.getByLabel('Authentication', { exact: true }).selectOption('none');
  await expect(page.getByText(/Anyone who can reach this port/)).toBeVisible();

  // And back, because the rest of the suite expects a door.
  await page.getByLabel('Authentication', { exact: true }).selectOption('forms');
  await expect(page.getByText(/Anyone who can reach this port/)).toHaveCount(0);
  expectNoPageErrors(consoleErrors);
});

test('choosing the proxy method asks which header to trust', async ({ page, consoleErrors }) => {
  await page.goto('/settings');

  await page.getByLabel('Authentication', { exact: true }).selectOption('external');
  await expect(page.getByLabel('User header')).toHaveValue('X-Forwarded-User');

  await page.getByLabel('Authentication', { exact: true }).selectOption('forms');
  expectNoPageErrors(consoleErrors);
});

test('a new API key can be minted, and it is shown once', async ({ page, consoleErrors }) => {
  await page.goto('/settings');

  await page.getByRole('button', { name: /Generate a new key|Generate a key/ }).click();
  await expect(page.getByText(/New API key generated/)).toBeVisible();

  const shown = await page.locator('.mono-block').first().innerText();
  expect(shown.trim().length).toBeGreaterThan(20);

  // Reloading does not show it again — it is stored hashed.
  await page.reload();
  await expect(page.locator('.mono-block')).toHaveCount(0);
  expectNoPageErrors(consoleErrors);
});

test('signing out really signs out, and the way back in is the password', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign out' }).click();

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('.nav')).toHaveCount(0);

  // A reload does not get you back in: the session is gone server-side.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Username', { exact: true }).fill(USERNAME);
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Wrong username or password')).toBeVisible();
  await expect(page.locator('.nav')).toHaveCount(0);

  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.nav')).toBeVisible();
});
