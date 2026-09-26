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
  await page.waitForFunction(() => !document.querySelector('#create-dialog').open || (document.querySelector('#create-status').textContent && !document.querySelector('#create-box').disabled), null, { timeout: 10 * 60 * 1000 });
  assert.equal(await page.locator('#create-dialog').isVisible(), false, await page.locator('#create-status').textContent());
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
  await bh('run', name, 'bash', '-lc', 'preview_dir=$(mktemp -d /tmp/boxhaven-desktop-preview.XXXXXX); printf "<h1>BoxHaven desktop preview verified</h1>" > "$preview_dir/index.html"; tmux new-session -d -s desktop-preview sudo python3 -m http.server "${BOXHAVEN_WEB_PORT:-80}" --bind "${BOXHAVEN_WEB_BIND:-0.0.0.0}" --directory "$preview_dir"');
  const box = JSON.parse((await bh('list', '--json')).stdout).machines.find(box => box.name === name);
  assert.ok(box.preview_url, 'Remote smoke requires a backend with web previews configured.');
  await expect.poll(async () => {
    try { return await (await fetch(box.preview_url, { signal: AbortSignal.timeout(10000) })).text(); }
    catch { return ''; }
  }, { timeout: 90000 }).toContain('BoxHaven desktop preview verified');
  await expect(reopened.locator('#open-preview')).toHaveAttribute('title', new URL(box.preview_url).href);
  await reopened.getByRole('button', { name: 'Open preview' }).click();
  await expect(reopened.locator('#action-error')).toBeHidden();
  // Supply the native confirmation only for this smoke's disposable machine.
  // Main-process revalidation and the real CLI destruction still execute.
  await app.evaluate(({ dialog }, name) => {
    dialog.showMessageBox = async (_window, options) => {
      if (options.message !== `Destroy “${name}”?` || options.defaultId !== 0) throw new Error('Unexpected destruction confirmation');
      return { response: 1 };
    };
  }, name);
  await reopened.getByRole('button', { name: 'Destroy box…', exact: true }).click();
  await expect(reopened.locator(`.box-row[data-name="${name}"]`)).toHaveCount(0, { timeout: 120000 });
  await expect(reopened.locator('#session-header')).toBeHidden();
  assert.equal(JSON.parse((await bh('list', '--json')).stdout).machines.some(box => box.name === name), false);
  await reopened.screenshot({ path: join(out, 'desktop-real-destroyed.png') });
  console.log('Real remote smoke passed: in-app creation, SSH/tmux persistence, live preview/browser opening, and in-app destruction confirmed absent from backend.');
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
