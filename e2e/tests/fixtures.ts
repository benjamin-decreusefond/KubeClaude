import { test as base, expect, type Page } from '@playwright/test';

export const USERNAME = 'e2e';
export const PASSWORD = 'a-good-password';

/**
 * Every spec starts signed in, and fails on a page that logged an error.
 *
 * Playwright gives each test its own context, which would mean its own empty
 * cookie jar — so the fixture signs in through the API before handing the page
 * over. `page.request` shares the context's cookies, so one call is enough and
 * the UI is left to the assertions rather than spent on logging in.
 *
 * Failed requests are not treated as page errors: a refused login is a 401 on
 * purpose, and the browser logs every one of those to the console.
 */
export const test = base.extend<{ page: Page; consoleErrors: string[] }>({
  consoleErrors: async ({}, use) => {
    await use([]);
  },

  page: async ({ page, consoleErrors }, use) => {
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (message.text().includes('Failed to load resource')) return;
      consoleErrors.push(message.text());
    });

    const state = await page.request.get('/api/auth/state');
    if (!(await state.json()).authenticated) {
      const login = await page.request.post('/api/auth/login', {
        data: { username: USERNAME, password: PASSWORD },
      });
      if (!login.ok()) throw new Error(`could not sign in: ${login.status()} ${await login.text()}`);
    }

    await use(page);
  },
});

export { expect };

/** Assert the page stayed quiet. Call it at the end of a test that navigated. */
export function expectNoPageErrors(errors: string[]): void {
  expect(errors, 'the page logged errors').toEqual([]);
}
