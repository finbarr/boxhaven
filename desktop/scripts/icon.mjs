// Render the flat classic smiling-box mark inside a separate native Dock tile.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Use the visible mark bounds so its own transparent margin does not add padding.
const logo = Buffer.from(readFileSync(new URL('../../brand/boxhaven.svg', import.meta.url), 'utf8')
  .replace('viewBox="0 0 64 64"', 'viewBox="6 6 52 52"')).toString('base64');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width:1024, height:1024 }, deviceScaleFactor:1 });
  await page.setContent(`<style>body{margin:0;background:transparent}.tile{position:absolute;inset:68px;background:#fff;border-radius:198px;display:grid;place-items:center}.tile img{width:80%;height:80%;object-fit:contain}</style><div class="tile"><img src="data:image/svg+xml;base64,${logo}"></div>`);
  await page.locator('img').evaluate(img => img.decode());
  await page.screenshot({path:fileURLToPath(new URL('../resources/icon.png',import.meta.url)),omitBackground:true});
} finally { await browser.close(); }
