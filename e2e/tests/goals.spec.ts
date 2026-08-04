import { expect, expectNoPageErrors, test } from './fixtures';

/** A goal, end to end: set it, watch it iterate, tick objectives, stop it. */
test.describe.configure({ mode: 'serial' });

const NAME = 'e2e-goal';

test('a goal is created with its objectives and starts working', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).click();

  await page.getByLabel('Name', { exact: true }).fill(NAME);
  // Exact: "Mission" is a substring of "Permission mode" further down the form.
  await page.getByLabel('Mission', { exact: true }).fill('Keep the e2e namespace green');
  await page.getByLabel('Objectives', { exact: true }).fill('Every pod ready\nNo pending PVC');
  await page.getByRole('button', { name: 'Create goal' }).click();

  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  await expect(page.getByText('Every pod ready')).toBeVisible();
  await expect(page.getByText('No pending PVC')).toBeVisible();
  await expect(page.getByText('0 of 2 done', { exact: false })).toBeVisible();

  // Creating it started the first iteration, which is a normal run.
  await expect(page.getByRole('button', { name: /Iterate now|Iterating…/ })).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('an objective can be ticked by hand, and the progress follows', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  // `click` rather than `check`: the box is controlled by the server's answer,
  // so it flips a beat after the click rather than on it.
  const objective = page.getByRole('checkbox', { name: 'Every pod ready' });
  await objective.click();
  await expect(objective).toBeChecked();
  await expect(page.getByText('1 of 2 done', { exact: false })).toBeVisible();

  await page.goto('/goals');
  await expect(page.getByText('1 of 2 objectives')).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('an objective can be added to a goal that is already running', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  await page.getByLabel('Add objectives').fill('Alerts fire before users notice');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(page.getByText('Alerts fire before users notice')).toBeVisible();
  await expect(page.getByText('1 of 3 done', { exact: false })).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('an objective can be made standing, and then nothing can tick it', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  const row = page.getByRole('row').filter({ hasText: 'No pending PVC' });
  await row.getByRole('button', { name: 'Standing' }).click();

  const objective = page.getByRole('checkbox', { name: 'No pending PVC' });
  await expect(objective).toBeDisabled();
  // Out of the bar it could never fill, and counted on its own instead.
  await expect(page.getByText('1 of 2 done', { exact: false })).toBeVisible();
  await expect(page.getByText('1 standing', { exact: false }).first()).toBeVisible();

  // And back again, so this is a choice rather than a trapdoor.
  await row.getByRole('button', { name: 'Closable' }).click();
  await expect(objective).toBeEnabled();
  await expect(page.getByText('1 of 3 done', { exact: false })).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('an objective can be removed, and the mission and cadence edited', async ({
  page,
  consoleErrors,
}) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('row')
    .filter({ hasText: 'Alerts fire before users notice' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('Alerts fire before users notice')).toHaveCount(0);
  await expect(page.getByText('1 of 2 done', { exact: false })).toBeVisible();

  // The mission and the cadence live behind Edit, in the header with everything
  // else you do to a goal.
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Mission', { exact: true }).fill('Keep the e2e namespace greener');
  await page.getByLabel('Wait between iterations (minutes)').fill('45');
  await page.getByRole('heading', { name: NAME }).click();

  await page.reload();
  await expect(page.getByText('Keep the e2e namespace greener')).toBeVisible();
  await expect(page.getByText('every 45 min', { exact: false }).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('the progress log fills in once an iteration has been reviewed', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  // The scheduler reviews finished iterations on its tick, which the e2e server
  // runs every two seconds.
  await expect(page.getByText('The iteration finished without a readable report.').first()).toBeVisible({
    timeout: 30_000,
  });
  // And the run behind it is reachable from the log.
  await expect(page.getByRole('button', { name: 'Run' }).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('a goal can be paused, and it stops there', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused').first()).toBeVisible();
  await expect(page.getByText(/This goal is paused/)).toBeVisible();

  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByText('Working').first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});

test('deleting a goal removes it and everything it ran', async ({ page, consoleErrors }) => {
  await page.goto('/goals');
  await page.getByRole('heading', { name: NAME }).click();

  await page.getByRole('button', { name: 'Pause' }).click();

  // In the header next to Pause and Iterate, the way a prompt carries its own
  // Delete — not at the foot of the collapsed Settings card it used to hide in.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole('heading', { name: NAME })).toHaveCount(0);
  expectNoPageErrors(consoleErrors);
});
