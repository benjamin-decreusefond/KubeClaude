import { expect, expectNoPageErrors, test } from './fixtures';

/**
 * The feed exists so that a fault has somewhere to go. These drive it the way
 * the app does: file one over the API the way a broken page would, read it back
 * on the page, dismiss it.
 */

test.beforeEach(async ({ page }) => {
  await page.request.delete('/api/errors');
});

test('a reported fault shows up, can be read and can be dismissed', async ({ page, consoleErrors }) => {
  await page.request.post('/api/errors', {
    data: {
      message: 'Cannot read properties of null (reading title)',
      detail: 'TypeError: Cannot read properties of null\n    at Prompts (/assets/index.js:2:2)',
      context: '/prompts',
    },
  });

  await page.goto('/errors');
  await expect(page.getByText('Cannot read properties of null (reading title)')).toBeVisible();
  await expect(page.getByText('/prompts')).toBeVisible();

  // The stack is a click away rather than in the way.
  await page.getByRole('button', { name: 'Stack' }).click();
  await expect(page.getByText(/at Prompts/)).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Nothing has gone wrong since this list was last cleared.')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('the same fault twice is one line with a count', async ({ page, consoleErrors }) => {
  const report = { message: 'poll failed', detail: 'Error\n    at usePolled (/assets/index.js:3:3)', context: '/' };
  await page.request.post('/api/errors', { data: report });
  await page.request.post('/api/errors', { data: report });

  await page.goto('/errors');
  await expect(page.getByText('poll failed')).toHaveCount(1);
  await expect(page.getByText('2×')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('the sidebar flags that something went wrong', async ({ page, consoleErrors }) => {
  await page.request.post('/api/errors', { data: { message: 'something broke', context: '/goals' } });

  await page.goto('/');
  const link = page.getByRole('link', { name: /^Errors/ });
  await expect(link).toContainText('1');

  await link.click();
  await expect(page.getByRole('heading', { name: 'Errors' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByText('Nothing has gone wrong since this list was last cleared.')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});
