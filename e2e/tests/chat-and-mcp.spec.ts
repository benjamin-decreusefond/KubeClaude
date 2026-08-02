import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, expectNoPageErrors, test } from './fixtures';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.describe.configure({ mode: 'serial' });

test('a chat starts, answers, and can be talked to again', async ({ page, consoleErrors }) => {
  await page.goto('/chats');

  await page.getByPlaceholder('Check whether the media namespace').fill('Is the media namespace healthy?');
  await page.getByRole('button', { name: 'Start chat' }).click();

  // Lands in the conversation, titled from the first line of the message.
  await expect(page).toHaveURL(/\/chats\/[0-9a-f-]+$/);
  await expect(page.getByText('Is the media namespace healthy?').first()).toBeVisible();

  // The reply comes back as a turn of its own, with what it cost attached.
  // Scoped to the transcript: text matching is case-insensitive, so a bare
  // "Claude" would also find the brand in the sidebar.
  await expect(page.locator('.chat-role', { hasText: 'Claude' }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/tokens · \$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'full log' })).toBeVisible();

  const composer = page.getByPlaceholder(/Reply to Claude/i);
  await composer.fill('And the PVCs?');
  await page.getByRole('button', { name: /^(Send|Queue)$/ }).click();
  await expect(page.getByText('And the PVCs?').first()).toBeVisible();

  expectNoPageErrors(consoleErrors);
});

test('the composer completes a saved prompt and a file in the workspace', async ({ page, consoleErrors }) => {
  // Something to complete to, created here so this test does not depend on what
  // the rest of the suite has left behind.
  const created = await page.request.post('/api/prompts', {
    data: { name: 'composer-target', prompt: 'Check the cluster and report what changed.' },
  });
  const targetId = (await created.json()).id as string;

  await page.goto('/chats');
  await page.getByRole('link', { name: 'Is the media namespace healthy?' }).click();
  const chatId = new URL(page.url()).pathname.split('/').pop()!;

  // A file in the chat's workspace for `@` to find. The stub CLI writes
  // nothing, so without this there would be nothing to complete to.
  const workspace = path.join(here, '.tmp/data/workspaces', chatId);
  fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs/runbook.md'), '# runbook');

  const composer = page.getByPlaceholder(/Reply to Claude/i);
  const menu = page.getByRole('listbox', { name: 'Suggestions' });
  await composer.click();

  // `/` at the start of the message offers saved prompts, and picking one drops
  // its whole text in — nothing is sent, and nothing is interpreted.
  await composer.pressSequentially('/composer');
  await expect(menu.getByRole('option', { name: /composer-target/ })).toBeVisible();
  await menu.getByRole('option', { name: /composer-target/ }).click();
  await expect(composer).toHaveValue('Check the cluster and report what changed.');

  // `@` looks in the working directory, and the chosen path lands in the
  // sentence being written rather than replacing it.
  await composer.fill('');
  await composer.pressSequentially('look at @runbook');
  await expect(menu.getByRole('option', { name: 'docs/runbook.md' })).toBeVisible();
  await composer.press('Enter');
  await expect(composer).toHaveValue('look at @docs/runbook.md ');

  // Enter took the suggestion rather than sending, so the message is still here.
  await expect(page.getByText('look at @docs/runbook.md').first()).toBeVisible();

  // And a trigger can be abandoned.
  await composer.pressSequentially('and @doc');
  await expect(menu).toBeVisible();
  await composer.press('Escape');
  await expect(menu).toHaveCount(0);

  // Taken away again: the prompt list is shared with the rest of the suite, and
  // a fixture left lying around is somebody else's flaky test.
  await page.request.delete(`/api/prompts/${targetId}`);

  expectNoPageErrors(consoleErrors);
});

test('a conversation is listed and can be deleted', async ({ page, consoleErrors }) => {
  await page.goto('/chats');
  await expect(page.getByRole('link', { name: 'Is the media namespace healthy?' })).toBeVisible();

  await page.getByRole('link', { name: 'Is the media namespace healthy?' }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /Delete/ }).click();

  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('link', { name: 'Is the media namespace healthy?' })).toHaveCount(0);
  expectNoPageErrors(consoleErrors);
});

test('an MCP connection is stored and previewed as the file Claude will read', async ({
  page,
  consoleErrors,
}) => {
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Add connection' }).click();

  await page.getByLabel('Name', { exact: true }).fill('k8s');
  await page
    .getByLabel('Configuration')
    .fill(JSON.stringify({ type: 'sse', url: 'https://mcp-k8s.example/sse' }, null, 2));
  await page.getByRole('button', { name: /^Save/ }).click();

  // The name appears both as the heading and inside the rendered config.
  await expect(page.getByText('k8s').first()).toBeVisible();
  await expect(page.getByText('mcp-k8s.example').first()).toBeVisible();

  expectNoPageErrors(consoleErrors);
});

test('a connection with broken JSON is refused rather than stored', async ({ page, consoleErrors }) => {
  await page.goto('/mcp');
  await page.getByRole('button', { name: 'Add connection' }).click();

  await page.getByLabel('Name', { exact: true }).fill('broken');
  await page.getByLabel('Configuration').fill('{ not json');
  await page.getByRole('button', { name: /^Save/ }).click();

  // Still on the form, with the reason.
  await expect(page.getByText(/JSON/i).first()).toBeVisible();
  expectNoPageErrors(consoleErrors);
});
