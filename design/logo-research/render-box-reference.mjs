import { chromium } from '../../desktop/node_modules/playwright/index.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const svg = await readFile(new URL('../website-layouts/assets/box-sprout.svg', import.meta.url), 'utf8');
  await page.setContent(`<style>html,body{margin:0;background:#f7f6f1}svg{display:block;width:512px;height:512px}</style>${svg}`);
  await page.screenshot({ path: fileURLToPath(new URL('./refinements/box-family-reference.png', import.meta.url)) });
} finally { await browser.close(); }
