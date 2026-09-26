import { _electron as electron, expect } from 'playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'bin/bh');
const temp = mkdtempSync(join(tmpdir(), 'boxhaven-desktop-remote-'));
const name = `desktop-smoke-${Date.now()}`;
const out = join(root, '.artifacts'); mkdirSync(out, { recursive: true });
const bh = (...args) => run(cli, args, { cwd: temp, timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
let app;
let attempted = false;
const launch = () => electron.launch(process.argv.includes('--packaged') ? {
  executablePath: join(root, `release/BoxHaven-${process.platform}-${process.arch}/BoxHaven.app/Contents/MacOS/BoxHaven`),
  args: [`--user-data-dir=${join(temp, 'profile')}`],
} : { args: [join(root, 'test/fixture-main.cjs')], env: { ...process.env, TEST_BH_CLI: cli, TEST_USER_DATA: join(temp, 'profile') } });
try {
  assert.equal(JSON.parse((await bh('list', '--json')).stdout).machines.some(box => box.name === name), false);
  attempted = true;
  console.log(`Creating disposable box ${name} inside the app without syncing any local files.`);
  app = await launch();
  const page = await app.firstWindow();
  const terminal = page.locator('.terminal-pane:not([hidden])');
  await page.getByRole('button', { name: 'New box', exact: true }).click();
  await page.getByLabel('Box name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create box', exact: true }).click();
  await page.screenshot({ path: join(out, 'desktop-real-creating.png') });
  await expect(page.locator('#create-dialog')).not.toBeVisible({ timeout: 10 * 60 * 1000 });
  // Wait for the actual remote shell, not merely successful PTY allocation.
  await expect(terminal).toContainText('boxhaven@', { timeout: 90000 });
  await page.keyboard.type("printf 'BOXHAVEN_DESKTOP_%s\\n' VERIFIED; export BOXHAVEN_DESKTOP_SMOKE=persisted");
  await page.keyboard.press('Enter');
  await expect(terminal).toContainText('BOXHAVEN_DESKTOP_VERIFIED', { timeout: 15000 });
  await page.screenshot({ path: join(out, 'desktop-real-remote.png') });
  await app.close(); app = null;
  await bh('run', name, 'tmux', 'has-session', '-t', 'boxhaven');
  app = await launch();
  const reopened = await app.firstWindow();
  await expect(reopened.locator('.terminal-pane:not([hidden])')).toContainText('boxhaven@', { timeout: 90000 });
  await reopened.keyboard.type('printf "PERSISTENCE_%s\\n" "$BOXHAVEN_DESKTOP_SMOKE"');
  await reopened.keyboard.press('Enter');
  await expect(reopened.locator('.terminal-pane:not([hidden])')).toContainText('PERSISTENCE_persisted', { timeout: 15000 });
  await reopened.screenshot({ path: join(out, 'desktop-real-reconnected.png') });
  console.log('Real remote smoke passed: in-app creation, automatic selection/connection, certificate SSH, tmux input/output, app close, session persistence, app reopen.');
} finally {
  if (app) await app.close();
  if (attempted) {
    const boxes = JSON.parse((await bh('list', '--json')).stdout).machines;
    if (boxes.some(box => box.name === name)) await bh('destroy', name, '--force');
    assert.equal(JSON.parse((await bh('list', '--json')).stdout).machines.some(box => box.name === name), false);
    console.log(`Confirmed ${name} removed.`);
  }
  rmSync(temp, { recursive: true, force: true });
}
