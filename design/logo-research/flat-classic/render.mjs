import { chromium } from '../../../desktop/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
const mark = readFileSync(new URL('./mark.svg', import.meta.url), 'utf8');
// Tight bounds prevent the source SVG's transparent padding from doubling the tile inset.
writeFileSync(new URL('./mark-tight.svg', import.meta.url), mark.replace('viewBox="0 0 64 64"', 'viewBox="6 6 52 52"'));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 790 }, deviceScaleFactor: 1 });
  await page.goto(new URL('./index.html', import.meta.url).href);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await page.screenshot({ path: fileURLToPath(new URL('./preview.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile overflow');
  await page.setViewportSize({ width: 1040, height: 660 });
  await page.goto(new URL('./padding.html', import.meta.url).href);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await page.screenshot({ path: fileURLToPath(new URL('./padding.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Padding comparison mobile overflow');
  await page.goto(new URL('./mark.svg', import.meta.url).href);
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.screenshot({ path: fileURLToPath(new URL('./mark.png', import.meta.url)), omitBackground: true });
} finally { await browser.close(); }
