import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "playwright-core";

const root=resolve(import.meta.dirname,"../..");
const site=resolve(root,"docs/.vitepress/dist");
const out=resolve(root,"backend/.artifacts/docs-connectors");
await mkdir(out,{recursive:true});
const server=createServer(async(req,res)=>{
  try {
    let path=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
    if(path==="/") path="/index.html"; else if(!extname(path)) path+=".html";
    const file=resolve(site,"."+path);
    if(!file.startsWith(site+"/")) {res.writeHead(403);res.end();return;}
    const mime={".html":"text/html",".js":"text/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"}[extname(file)] || "application/octet-stream";
    res.writeHead(200,{"Content-Type":mime});res.end(await readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const executablePath=[process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/usr/bin/google-chrome","/usr/bin/chromium"].filter(Boolean).find(existsSync);
assert.ok(executablePath,"Chrome is required");
const browser=await chromium.launch({executablePath,headless:true});
try {
  for(const [name,path] of [["home","/","#documentation"],["providers","/providers","#exe-dev"],["self-hosting","/self-hosting"],["security","/security"],["getting-started","/getting-started"],["commands","/commands"]]) {
    for(const [size,viewport] of Object.entries({desktop:{width:1440,height:1000},mobile:{width:390,height:844}})) {
      const page=await browser.newPage({viewport});
      const response=await page.goto(`http://127.0.0.1:${server.address().port}${path}`,{waitUntil:"networkidle"});
      assert.ok(response.ok());
      if(name==="providers") {
        await page.locator("h2#all-providers-in-boxes").evaluate(heading => window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - 150, behavior: "instant" }));
        await page.screenshot({path:resolve(out,`boxes-${size}.png`)});
        const heading=page.locator("h2#exe-dev");await heading.scrollIntoViewIfNeeded();
        assert.match(await page.locator(".vp-doc").innerText(),/live smoke verifies creation/);
      } else if(name==="self-hosting") await page.locator("h2#backend-relay-capacity").scrollIntoViewIfNeeded();
      else if(name==="security") await page.locator("h1").scrollIntoViewIfNeeded();
      else if(name==="getting-started") {
        await page.locator("h2#open-a-web-preview").evaluate(heading => window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - 150, behavior: "instant" }));
        await page.screenshot({path:resolve(out,`preview-guide-${size}.png`)});
        await page.locator("h2#enable-ssh-access").scrollIntoViewIfNeeded();
      }
      else if(name==="commands") await page.locator("h2#bh-preview").scrollIntoViewIfNeeded();
      else { const link=page.getByRole("link",{name:"Cloud providers",exact:true}); await link.last().scrollIntoViewIfNeeded(); }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name}/${size} overflow`);
      await page.screenshot({path:resolve(out,`${name}-${size}.png`)});
      if(name==="providers") {
        await page.getByText("The live smoke verifies creation",{exact:false}).scrollIntoViewIfNeeded();
        await page.screenshot({path:resolve(out,`provider-validation-${size}.png`)});
      }
      console.log(`PASS ${name}/${size}`);await page.close();
    }
  }
} finally {await browser.close();await new Promise(r=>server.close(r));}
