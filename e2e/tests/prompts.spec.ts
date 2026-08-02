import { expect, expectNoPageErrors, test } from './fixtures';

/** A prompt, end to end: write it, schedule it, run it, read the run, delete it. */
test.describe.configure({ mode: 'serial' });

const NAME = 'e2e-prompt';

test('a prompt can be created from the editor', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('link', { name: 'New prompt' }).click();

  await page.getByLabel('Name', { exact: true }).fill(NAME);
  await page.getByLabel('Prompt', { exact: true }).fill('Check whether the pods are healthy');
  await page.getByRole('button', { name: 'Create prompt' }).click();

  await page.goto('/prompts');
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  // A prompt with no trigger says so rather than looking scheduled.
  await expect(page.getByText('No triggers — runs only when you ask')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('a repository can be attached to a prompt, and a bad remote is refused', async ({
  page,
  consoleErrors,
}) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME }).click();
  // The repository lives with the rest of what a run can reach.
  await page.getByRole('button', { name: 'Access', exact: true }).click();

  await page.getByLabel('Repository', { exact: true }).fill('https://github.com/owner/repo.git');
  await page.getByLabel('Branch, tag or commit').fill('main');
  await page.getByRole('button', { name: 'Save' }).click();

  // A reload starts on the first tab again, so ask for the one it lives on.
  await page.reload();
  await page.getByRole('button', { name: 'Access', exact: true }).click();
  await expect(page.getByLabel('Repository', { exact: true })).toHaveValue('https://github.com/owner/repo.git');
  await expect(page.getByLabel('Branch, tag or commit')).toHaveValue('main');

  // A path on the data volume is not a remote, and the API says so rather than
  // handing it to `git clone`.
  await page.getByLabel('Repository', { exact: true }).fill('/data/kubeclaude.db');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/https:\/\/ or git@host/)).toBeVisible();

  // Put it back so the rest of the suite sees the prompt it expects.
  await page.getByLabel('Repository', { exact: true }).fill('');
  await page.getByLabel('Branch, tag or commit').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  expectNoPageErrors(consoleErrors);
});

test('an edit is saved and shown on the list', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME }).click();

  await page.getByLabel('Description', { exact: true }).fill('Looks at the media namespace');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.goto('/prompts');
  await expect(page.getByText('Looks at the media namespace')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('a trigger can be attached and paused', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME }).click();

  // Triggers live behind the Schedule tab, not on the task itself.
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('button', { name: 'Add trigger' }).click();
  await page.getByLabel('Trigger type').selectOption('cron');
  await page.getByLabel('Cron expression').fill('0 9 * * *');
  // The preview is what tells you the expression means what you think.
  await expect(page.getByText('Next runs')).toBeVisible();
  await page.getByRole('button', { name: 'Save trigger' }).click();

  await expect(page.getByRole('cell', { name: /Cron schedule/ })).toBeVisible();

  // Pausing it keeps it listed, but marked. Scoped to the table: "Resume" is
  // also one of the editor's tabs.
  const triggers = page.locator('table');
  await triggers.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused')).toBeVisible();
  await triggers.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Paused')).toHaveCount(0);

  await page.goto('/prompts');
  // The list is where you check what is scheduled, so it has to reach it.
  await expect(page.getByText(/Cron schedule/).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('running it produces a run you can open and read', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('button', { name: 'Run now' }).first().click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  // The fake CLI answers immediately, so this settles rather than spinning.
  await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });
  // What the run actually said, not just that it happened. It shows up both in
  // the summary and in the log, so take the first.
  await expect(page.getByText(/done: Check whether the pods are healthy/).first()).toBeVisible();

  await page.goto('/runs');
  await expect(page.getByRole('link', { name: NAME }).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('the overview shows the run that just happened', async ({ page, consoleErrors }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(NAME).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('deleting a prompt takes it off the list', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME }).click();

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /Delete/ }).click();

  await expect(page).toHaveURL(/\/prompts$/);
  await expect(page.getByRole('heading', { name: NAME })).toHaveCount(0);
  expectNoPageErrors(consoleErrors);
});
