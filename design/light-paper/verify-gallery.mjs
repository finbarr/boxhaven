import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../desktop/node_modules/playwright/index.mjs';

const artifacts = new URL('../../desktop/.artifacts/light-paper/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [name, width, height] of [['desktop', 1440, 1100], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto(new URL('index.html', import.meta.url).href);
    await page.locator('figure img').evaluateAll(async images => {
      await Promise.all(images.map(async image => {
        image.loading = 'eager';
        await image.decode();
      }));
    });
    assert.equal(await page.locator('figure img').count(), 8);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const link of await page.locator('.image-link').all()) {
      await link.click();
      assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), true);
      await page.locator('dialog img').evaluate(image => image.decode());
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('dialog').evaluate(dialog => dialog.open), false);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, artifacts)), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Gallery verified: 8 images, enlargement, Escape, desktop/mobile layout, no page errors.');
} finally {
  await browser.close();
}
