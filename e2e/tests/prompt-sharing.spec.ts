import { expect, expectNoPageErrors, test } from './fixtures';

/**
 * The three ways a prompt gets reused rather than retyped — duplicated,
 * exported to a file, imported back from one — and finding a run again
 * afterwards by something it said.
 */
test.describe.configure({ mode: 'serial' });

const NAME = 'e2e-sharing';
const MARKER = 'zebrafish-telemetry';

test('a prompt is created to share', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('link', { name: 'New prompt' }).click();

  await page.getByLabel('Name', { exact: true }).fill(NAME);
  await page.getByLabel('Prompt', { exact: true }).fill(`Look into the ${MARKER} readings`);
  await page.getByRole('button', { name: 'Create prompt' }).click();

  await expect(page).toHaveURL(/\/prompts\/[0-9a-f-]+$/);
  expectNoPageErrors(consoleErrors);
});

test('duplicating gives a copy under its own name, and leaves the original alone', async ({
  page,
  consoleErrors,
}) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME, exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate' }).click();

  // It lands on the copy, which carries the configuration but not the name.
  await expect(page.getByRole('heading', { name: `${NAME} (copy)` })).toBeVisible();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(
    `Look into the ${MARKER} readings`,
  );

  await page.goto('/prompts');
  await expect(page.getByRole('heading', { name: NAME, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: `${NAME} (copy)` })).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('a prompt exports to a file and imports back from one', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME, exact: true }).click();

  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]).then(([event]) => event);

  const file = await download.path();
  expect(file, 'the export should have produced a file').toBeTruthy();

  // What came out is the configuration, with nothing this database-specific
  // in it — the id would collide, and the run history means nothing elsewhere.
  const fs = await import('node:fs/promises');
  const exported = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  expect(exported.name).toBe(NAME);
  expect(exported.prompt).toBe(`Look into the ${MARKER} readings`);
  expect(exported.id).toBeUndefined();

  // And the same file read back in is a working prompt again.
  const reimported = { ...exported, name: `${NAME}-imported` };
  const path = await import('node:path');
  const os = await import('node:os');
  const scratch = path.join(os.tmpdir(), `kubeclaude-e2e-${Date.now()}.json`);
  await fs.writeFile(scratch, JSON.stringify(reimported));

  await page.goto('/prompts');
  await page.locator('input[type="file"]').setInputFiles(scratch);

  await expect(page).toHaveURL(/\/prompts\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: `${NAME}-imported` })).toBeVisible();
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveValue(
    `Look into the ${MARKER} readings`,
  );

  await fs.rm(scratch, { force: true });
  expectNoPageErrors(consoleErrors);
});

test('a run can be found again by something it was asked to do', async ({ page, consoleErrors }) => {
  await page.goto('/prompts');
  await page.getByRole('heading', { name: NAME, exact: true }).click();
  await page.getByRole('button', { name: 'Run now' }).click();

  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await expect(page.getByText('Succeeded')).toBeVisible({ timeout: 20_000 });

  await page.goto('/runs');
  const search = page.getByPlaceholder(/Search runs/);
  await search.fill(MARKER);
  await expect(page.getByRole('link', { name: NAME, exact: true }).first()).toBeVisible();

  // A term nothing said narrows it to nothing, rather than quietly ignoring
  // the box and showing everything.
  await search.fill('nothing-ever-said-this');
  await expect(page.getByText('No runs match this filter.')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('the copies are cleaned up', async ({ page }) => {
  for (const name of [`${NAME} (copy)`, `${NAME}-imported`, NAME]) {
    await page.goto('/prompts');
    await page.getByRole('heading', { name, exact: true }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: /^Delete/ }).click();
    await expect(page).toHaveURL(/\/prompts$/);
  }
  await expect(page.getByRole('heading', { name: NAME })).toHaveCount(0);
});
