// Render the original, untouched cabin inside a native-style Dock tile.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const logo = readFileSync(new URL('../../backend/app/src/assets/boxhaven-logo.png', import.meta.url)).toString('base64');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width:1024, height:1024 }, deviceScaleFactor:1 });
  await page.setContent(`<style>body{margin:0;background:transparent}.tile{position:absolute;inset:68px;background:#fff;border-radius:198px;box-shadow:0 18px 24px #0003;display:grid;place-items:center}.tile img{width:82%;height:82%;object-fit:contain}</style><div class="tile"><img src="data:image/png;base64,${logo}"></div>`);
  await page.locator('img').evaluate(img => img.decode());
  await page.screenshot({path:fileURLToPath(new URL('../resources/icon.png',import.meta.url)),omitBackground:true});
} finally { await browser.close(); }
