// Feature: LLM settings modal (bring-your-own-key).
//   - ⚙ gear opens the AI settings dialog
//   - Protocol select offers openai / anthropic / responses and switching it
//     keeps the credential form coherent  (NOTE: the spec'd per-protocol
//     field-visibility switch — e.g. an "x-api-key" hint for anthropic — is
//     NOT in the shipped build yet; hints are static. Documented in
//     qa-report/e2e-expansion.md; this test pins current behavior.)
//   - Test Connection with a dummy key surfaces a graceful error status
//     (static preview has no /api/llm relay)
//   - profiles Save → localStorage "greek-reader.llm.profiles", reloaded
//     into the form when the modal reopens
//
// Selectors: the modal builds selects/inputs WITHOUT type/aria attrs —
// fields are identified by their <label><span> text; the protocol select is
// the 2nd .ai-select (profile picker is 1st, thinking-effort 3rd).
import { test, expect } from '@playwright/test';

const modal = () => page.locator('.ai-modal[role="dialog"]');
let page: import('@playwright/test').Page;

test.beforeEach(async ({ page: p }) => {
  page = p;
  await p.goto('/#/');
  await p.waitForSelector('#ai-gear', { state: 'attached' });
  await p.locator('#ai-gear').click();
});

/** Field wrapper located by its visible label text. */
function field(label: string) {
  return modal().locator('.ai-field').filter({ hasText: label });
}

const protoSel = () => modal().locator('select.ai-select').nth(1);
const keyInp = () => modal().locator('input[type="password"]');
const modelInp = () => field('Model').locator('input');

test.describe('LLM settings modal', () => {
  test('gear opens Settings; protocol select switches and form stays coherent', async () => {
    await expect(modal()).toBeVisible();
    await expect(modal().locator('h2')).toContainText('AI Settings');

    await expect(protoSel().locator('option')).toHaveCount(3); // openai|anthropic|responses
    await protoSel().selectOption('anthropic');
    await expect(protoSel()).toHaveValue('anthropic');
    // credential fields remain visible + editable after the protocol switch
    await expect(keyInp()).toBeVisible();
    await keyInp().fill('sk-dummy');
    await expect(keyInp()).toHaveValue('sk-dummy');
  });

  test('Test Connection with dummy key shows a graceful error, no crash', async () => {
    // model is required by validate() before any network attempt
    await modelInp().fill('qa-test-model');
    await keyInp().fill('sk-dummy-key-123');
    await modal().getByRole('button', { name: 'Test Connection' }).click();
    const status = modal().locator('.ai-status');
    await expect(status).toHaveClass(/ai-error/, { timeout: 20_000 });
    expect((await status.textContent()) ?? '').not.toBe('');
  });

  test('profiles save to localStorage and reload into the form on reopen', async ({ page: p }) => {
    await field('Profile name').locator('input').fill('QA Expansion Profile');
    await modelInp().fill('qa-test-model');
    await modal().getByRole('button', { name: 'Save' }).click();
    await expect(modal().locator('.ai-status')).toHaveClass(/ai-ok/);

    const stored = await p.evaluate(() =>
      localStorage.getItem('greek-reader.llm.profiles') ?? '');
    expect(stored).toContain('QA Expansion Profile');

    await modal().getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('.ai-modal')).toHaveCount(0);
    await page.locator('#ai-gear').click();
    await expect(modal()).toBeVisible();
    await expect(field('Profile name').locator('input'))
      .toHaveValue('QA Expansion Profile');
  });
});
