import { chromium } from '../../desktop/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=fileURLToPath(new URL('./',import.meta.url));
await mkdir(resolve(dir,'.artifacts'),{recursive:true});
const server=createServer(async(req,res)=>{
 const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 const file=resolve(root,`.${path.endsWith('/')?path+'index.html':path}`);
 if(!file.startsWith(root)){res.writeHead(403).end();return;}
 try{const content=await readFile(file);res.writeHead(200,{'Content-Type':{'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.svg':'image/svg+xml','.md':'text/plain'}[extname(file)]||'application/octet-stream'}).end(content);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/design/website-layouts/`;
const browser=await chromium.launch({channel:'chrome'});
try{
 for(const option of ['a','b','c'])for(const width of [1440,390,320]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+option+'.html');await page.locator('h1').waitFor();
  assert.equal(await page.locator('h1').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${option} ${width} overflow`);
  assert.deepEqual(await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.src)),[]);
  if(width!==320)await page.screenshot({path:resolve(dir,`previews/${option}-${width===1440?'desktop':'mobile'}.png`)});
  await page.screenshot({path:resolve(dir,`.artifacts/${option}-${width}-full.png`),fullPage:true});
  if(option==='a' && width!==320)for(const section of ['parallel','start']){
   await page.locator('#'+section).screenshot({path:resolve(dir,`.artifacts/a-${width}-${section}.png`)});
  }
  await page.getByRole('tab',{name:/search-feature/}).click();
  assert.equal(await page.locator('#terminal-name').textContent(),'search-feature');
  assert.match(await page.locator('#terminal').textContent(),/product search/);
  await page.getByRole('tab',{name:/homepage-idea/}).click();
  assert.equal(await page.locator('#terminal-name').textContent(),'homepage-idea');
  if(option==='c'){
   await page.getByRole('button',{name:'Explore ideas',exact:true}).click();
   assert.match(await page.locator('#scenario-cards').textContent(),/editorial layout/);
   await page.getByRole('button',{name:'Clear a backlog',exact:true}).click();
   assert.match(await page.locator('#scenario-cards').textContent(),/flaky test/);
  }
  await page.getByRole('link',{name:'Get started',exact:false}).click();
  if(option==='a'){
   assert.equal(await page.locator('#parallel .task-cards').count(),0);
   assert.equal(await page.locator('.product-feature').count(),6);
   assert.equal(await page.locator('.entry-option').count(),2);
   await page.getByRole('button',{name:'Copy CLI install command',exact:true}).click();
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'brew install finbarr/tap/boxhaven');
   await page.getByText('Add the agent skill',{exact:true}).click();
  }
  await page.getByRole('button',{name:'Copy install command',exact:true}).click();
  assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'npx skills add finbarr/boxhaven --skill boxhaven -g -a codex claude-code');
  if(option!=='a')await page.getByText('First-time setup',{exact:true}).click();
  assert.equal(await page.locator('details').getAttribute('open'),'');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  const locals=await page.locator('a[href]').evaluateAll(links=>links.map(a=>a.getAttribute('href')).filter(h=>!h.startsWith('http')));
  for(const href of new Set(locals)){
   if(href.startsWith('#'))assert.equal(await page.locator(href).count(),1,`${option} missing ${href}`);
   else assert.equal((await context.request.get(new URL(href,base).href)).ok(),true,`${option} broken ${href}`);
  }
  await context.close();
 }
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(base+'index.html');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'gallery overflow');
  await page.screenshot({path:resolve(dir,`.artifacts/gallery-${width}.png`),fullPage:true});
 }
 console.log(JSON.stringify({ok:true,concepts:3,widths:[1440,390,320],gallery:base+'index.html'}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
