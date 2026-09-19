import {pathToFileURL} from "node:url";
import assert from "node:assert/strict";
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({channel:"msedge",headless:true}),page=await browser.newPage();
const errors=[],posts=[];
page.on("pageerror",e=>errors.push(e.message));
// UI tests never start an additional real collection.
await page.route(/http:\/\/127\.0\.0\.1:879[123]\/.*/,async route=>{
 const r=route.request();
 if(r.method()==="OPTIONS")return route.fulfill({status:204,headers:{"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"content-type"}});
 if(r.method()==="POST")posts.push({port:new URL(r.url()).port,body:r.postDataJSON()});
 await route.fulfill({status:r.method()==="POST"?202:200,contentType:"application/json",headers:{"access-control-allow-origin":"*"},body:JSON.stringify({state:r.method()==="POST"?"running":"complete",message:"测试模拟完成，不执行采集"})});
});
try{
 await page.goto("http://127.0.0.1:5173/cross-validation");await page.waitForLoadState("networkidle");
 const names=["广场情绪","合约指标","Hyperliquid 聪明钱"];
 assert.equal(await page.getByRole("checkbox").count(),3);
 for(const excluded of names){
  await page.getByRole("checkbox",{name:excluded,exact:true}).click();
  assert.equal(await page.locator(".cv-results th").count(),3);
  assert.equal(await page.locator(".cv-results th").filter({hasText:excluded}).count(),0);
  await page.getByRole("checkbox",{name:excluded,exact:true}).click();
  assert.equal(await page.locator(".cv-results th").count(),4);
 }
 await page.getByRole("checkbox",{name:names[0],exact:true}).click();await page.getByRole("checkbox",{name:names[1],exact:true}).click();
 await page.getByRole("heading",{name:"请至少选择两个模块"}).waitFor();
 assert.equal(await page.getByRole("button",{name:"更新所选模块一次",exact:true}).isDisabled(),true);
 await page.getByRole("checkbox",{name:names[0],exact:true}).click();
 await page.getByRole("button",{name:"更新所选模块一次",exact:true}).click();
 await page.waitForFunction(()=>document.body.innerText.includes("测试模拟完成"));
 await page.waitForTimeout(2300);
 assert.deepEqual(posts.map(p=>p.port).sort(),["8792","8793"]);
 assert.deepEqual(posts.find(p=>p.port==="8792").body,{});
 posts.length=0;
 await page.getByRole("button",{name:"全部更新一次",exact:true}).click();await page.waitForTimeout(2400);
 assert.deepEqual(posts.map(p=>p.port).sort(),["8791","8792","8793"]);
 await page.getByRole("checkbox",{name:names[1],exact:true}).click();
 await page.getByRole("textbox",{name:"交叉币种搜索"}).fill("NO_SUCH_TOKEN");
 assert.equal(await page.locator(".cv-results tbody tr").count(),0);
 await page.getByRole("textbox",{name:"交叉币种搜索"}).fill("");
 await page.getByRole("combobox",{name:"聪明钱样本池"}).click();await page.getByRole("option",{name:"两个池 · 探索",exact:true}).click();
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await page.locator(".cv-results td p").evaluateAll(els=>els.every(e=>e.scrollWidth<=e.clientWidth+1)));
  const y=await page.locator('nav[aria-label="分析模块"] a').evaluateAll(a=>a.map(e=>e.getBoundingClientRect().y));assert.equal(new Set(y).size,1);
  if(width!==320)await page.screenshot({path:".sites-runtime/cross-"+width+".png"});
 }
 await page.goto("http://127.0.0.1:5173/square");await page.waitForLoadState("networkidle");
 assert.equal(await page.getByRole("tab",{name:"真实数据",exact:true}).getAttribute("aria-selected"),"true");
 assert.ok(await page.locator("tbody tr").count()>0);
 await page.locator("tbody tr").first().getByRole("button").first().click();
 await page.getByRole("heading",{name:"原帖与分享卡"}).waitFor();
 await page.getByRole("link",{name:"查看币安原帖 ↗"}).waitFor();
 assert.deepEqual(errors,[]);console.log("PASS four combinations, minimum selection, selected/all updates mocked, search, pool, mobile, real square and source links");
}finally{await browser.close();}
