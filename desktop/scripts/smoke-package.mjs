// No account credentials or remote VMs: exercise the packaged native code locally.
import { _electron as electron, expect } from 'playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const bundle = resolve(process.argv[2]);
const profile = mkdtempSync(join(tmpdir(), 'boxhaven-package-smoke-'));
const cli = join(bundle, 'Contents/Resources/app/bin/bh');
assert.match(execFileSync(cli, ['version'], { encoding: 'utf8' }), /\d|[a-f0-9]{7}/);
let app;
try {
  app = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/BoxHaven'), args: [`--user-data-dir=${profile}`], env: { ...process.env, XDG_CONFIG_HOME: profile, BOXHAVEN_TOKEN: '', BOXHAVEN_BACKEND_URL: '' } });
  const page = await app.firstWindow();
  await expect(page.locator('body')).toContainText('BoxHaven');
  await page.locator('.brand img').evaluate(img => img.decode());
  const screenshots = fileURLToPath(new URL('../.artifacts/', import.meta.url));
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, 'desktop-packaged.png') });
  const output = await app.evaluate(async ({ app }) => {
    const { createRequire } = process.getBuiltinModule('module');
    const require = createRequire(app.getAppPath() + '/package.json');
    const pty = require('node-pty');
    return new Promise((resolve, reject) => {
      let data = '';
      const proc = pty.spawn('/bin/sh', ['-c', 'printf packaged-pty-ok'], { env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24 });
      const timeout = setTimeout(() => { proc.kill(); reject(new Error('Packaged PTY timed out')); }, 10000);
      proc.onData(chunk => { data += chunk; });
      proc.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? resolve(data) : reject(new Error('Packaged PTY failed: ' + exitCode)); });
    });
  });
  assert.match(output, /packaged-pty-ok/);
  console.log('Packaged window, bundled CLI, and native PTY passed.');
} finally { if (app) await app.close(); rmSync(profile, { recursive: true, force: true }); }
