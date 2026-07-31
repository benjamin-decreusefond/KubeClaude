import { expect, expectNoPageErrors, test } from './fixtures';

/**
 * Every page renders on an instance that has barely any data. Cheap, and it is
 * the check that catches a component that throws on an empty list — the state
 * every screen is in on day one and the one nobody develops against.
 */
const PAGES: Array<{ path: string; heading: string }> = [
  { path: '/', heading: 'Overview' },
  { path: '/chats', heading: 'Chat' },
  { path: '/prompts', heading: 'Prompts' },
  { path: '/goals', heading: 'Goals' },
  { path: '/runs', heading: 'Runs' },
  { path: '/mcp', heading: 'MCP connections' },
  { path: '/settings', heading: 'Settings' },
];

for (const { path, heading } of PAGES) {
  test(`${heading} renders`, async ({ page, consoleErrors }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    expectNoPageErrors(consoleErrors);
  });
}

test('the sidebar navigates without a reload, and says which build this is', async ({ page, consoleErrors }) => {
  await page.goto('/');

  await page.getByRole('link', { name: 'Goals' }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page).toHaveURL(/\/runs$/);

  // The version is the first question after a deploy, so it is always on screen.
  await expect(page.getByText(/^KubeClaude /)).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('an unknown route lands somewhere real rather than a blank page', async ({ page, consoleErrors }) => {
  await page.goto('/not-a-page');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expectNoPageErrors(consoleErrors);
});
