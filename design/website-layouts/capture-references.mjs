import { chromium } from '../../desktop/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';
const out = new URL('./.artifacts/references/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({channel:'chrome'});
try {
  const results = await Promise.allSettled([
    ['conductor','https://www.conductor.build/'], ['blaxel','https://blaxel.ai/'],
    ['e2b','https://e2b.dev/'], ['daytona','https://www.daytona.io/']
  ].map(async ([name,url])=>{
    const page=await browser.newPage({viewport:{width:1440,height:1100}, reducedMotion:'reduce'});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForTimeout(2500);
    await page.screenshot({path:new URL(`${name}.png`,out).pathname});
    await page.close();
    return name;
  }));
  console.log(results.map(r=>r.status==='fulfilled'?r.value:String(r.reason)));
} finally { await browser.close(); }
