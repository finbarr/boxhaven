import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../desktop/node_modules/playwright/index.mjs';

const out = new URL('./.artifacts/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const errors = [];
  const page = await browser.newPage({ deviceScaleFactor: 1, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('./index.html', import.meta.url).href);
  await page.addStyleTag({ content: 'html { scroll-behavior: auto !important; }' });
  assert.equal(await page.locator('.concept').count(), 8);
  assert.equal(await page.locator('.concept .art-stage img[src^="marks/"]').count(), 8);
  assert.equal(await page.locator('img[src^="concepts/"]').count(), 0);
  assert.equal(await page.locator('.reference').count(), 13);
  assert.equal(await page.locator('.guide').count(), 15);
  await page.locator('img:not(#modal-image)').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  for (const [name, width, height] of [['desktop', 1440, 1100], ['tablet', 900, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => scrollY), 0, `${name} screenshot starts at the top`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow`);
    for (const sample of await page.locator('.size-sample').all()) {
      const size = Number(await sample.getAttribute('data-size'));
      const box = await sample.boundingBox();
      assert.equal(box.width, size, `${name} preview width`);
      assert.equal(box.height, size, `${name} preview height`);
    }
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-overview.png`, out)) });
    if (name === 'desktop') {
      await page.locator('#studies').screenshot({ path: fileURLToPath(new URL('all-eight.png', out)) });
      await page.locator('#references').screenshot({ path: fileURLToPath(new URL('references.png', out)) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const button of await page.locator('.zoom').all()) {
    await button.click();
    assert.equal(await page.locator('dialog').evaluate(node => node.open), true);
    await page.locator('#modal-image').evaluate(image => image.decode());
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
  }
  await page.locator('[id="05-outline"] .compare-this').click();
  assert.equal(await page.locator('#right').inputValue(), '05-outline');
  await page.locator('#left').selectOption('02-square');
  assert.ok((await page.locator('#left-preview .comparison-hero').getAttribute('src')).includes('02-square'));
  for (const background of ['dark', 'gray', 'paper']) {
    await page.locator(`#compare button[data-background="${background}"]`).click();
    assert.equal(await page.locator('body').getAttribute('data-background'), background);
    assert.equal(await page.locator(`button[data-background="${background}"][aria-pressed="true"]`).count(), 2);
    await page.locator('#compare').screenshot({ path: fileURLToPath(new URL(`compare-${background}.png`, out)) });
  }
  await page.locator('#left').selectOption('01-classic');
  await page.locator('#right').selectOption('02-square');
  await page.locator('#compare').screenshot({ path: fileURLToPath(new URL('compare-finalists.png', out)) });
  await page.goto(new URL('./refinements.html', import.meta.url).href);
  assert.equal(await page.locator('.grid article').count(), 8);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} refinements overflow`);
    for (const image of await page.locator('.normalized').all()) {
      const box = await image.boundingBox();
      const fraction = Number(await image.getAttribute('data-front-fraction'));
      assert.ok(Math.abs(box.width * fraction - 220) < 0.1, 'Equal front-panel width');
    }
    await page.screenshot({ path: fileURLToPath(new URL(`refinements-${name}.png`, out)), fullPage: true });
  }
  await page.goto(new URL('./h-colors.html', import.meta.url).href);
  assert.equal(await page.locator('.grid article').count(), 4);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} color studies overflow`);
    await page.screenshot({ path: fileURLToPath(new URL(`h-colors-${name}.png`, out)), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log('Verified 4 face colors, 8 refinements, 8 concepts, 13 reference images, 15 guides, actual CSS sizes, comparison controls, backgrounds, modal keyboard dismissal, and desktop/tablet/mobile layout.');
} finally {
  await browser.close();
}
