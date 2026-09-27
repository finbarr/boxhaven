import { chromium } from '../../../desktop/node_modules/playwright/index.mjs';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 790 }, deviceScaleFactor: 1 });
  await page.goto(new URL('./index.html', import.meta.url).href);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  await page.screenshot({ path: fileURLToPath(new URL('./preview.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile overflow');
  await page.goto(new URL('./mark.svg', import.meta.url).href);
  await page.setViewportSize({ width: 1024, height: 1024 });
  await page.screenshot({ path: fileURLToPath(new URL('./mark.png', import.meta.url)), omitBackground: true });
} finally { await browser.close(); }
