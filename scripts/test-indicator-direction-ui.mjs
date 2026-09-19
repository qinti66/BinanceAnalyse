import assert from "node:assert/strict";
import {pathToFileURL} from "node:url";
import {analyzeDirection} from "../lib/indicators/direction.ts";
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({channel:"msedge",headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];let updates=0;page.on("pageerror",e=>errors.push(e.message));page.on("request",r=>{if(r.method()==="POST"&&r.url().includes("/update"))updates++;});
try{
 const s=await(await fetch("http://127.0.0.1:5173/indicators/latest.json")).json();
 await page.goto("http://127.0.0.1:5173/indicators");await page.waitForLoadState("networkidle");
 assert.equal(await page.locator(".im-list tbody tr").count(),s.coverage.candidates);
 assert.equal(await page.locator(".im-list td.im-direction").count(),s.coverage.candidates);
 await page.locator(".im-direction summary").first().click();
 assert.match(await page.locator(".im-direction").first().innerText(),/价格 × 主动成交/);
 await page.locator(".im-direction summary").first().click();
 await page.getByRole("tab",{name:"全部代币",exact:true}).click();
 assert.equal(await page.locator(".im-list tbody tr").count(),s.coverage.tokens);
 const expected=s.coins.map(c=>analyzeDirection(c,s.cutoff));
 for(const [label,state] of [["偏多 · 多头观察","long"],["偏空 · 空头观察","short"],["观望／数据不足","wait"]]){
  await page.getByRole("combobox",{name:"方向研判",exact:true}).click();
  await page.getByRole("option",{name:label,exact:true}).click();
  assert.equal(await page.locator(".im-list tbody tr").count(),expected.filter(a=>state==="wait"?!["long","short"].includes(a.state):a.state===state).length);
 }
 await page.getByRole("combobox",{name:"方向研判",exact:true}).click();await page.getByRole("option",{name:"全部方向",exact:true}).click();
 await page.getByRole("textbox",{name:"搜索币种"}).fill("BTC");
 await page.getByRole("button",{name:"查看 BTC 指标",exact:true}).click();
 assert.match(await page.getByRole("region",{name:"币种方向研判"}).innerText(),/BTC · 综合参数分析/);
 await page.getByRole("textbox",{name:"搜索币种"}).fill("NO_SUCH_TOKEN");
 assert.equal(await page.locator(".im-direction-detail").count(),0);
 await page.getByRole("button",{name:"查看全部代币",exact:true}).click();
 await page.getByRole("tab",{name:"观察名单",exact:true}).click();
 await page.locator(".im-list").scrollIntoViewIfNeeded();
 await page.screenshot({path:".sites-runtime/indicator-direction-desktop.png"});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.ok(await page.locator(".im-direction p").evaluateAll(els=>els.filter(e=>e.clientWidth).every(e=>e.scrollWidth<=e.clientWidth+1)));
 }
 assert.equal(updates,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:"direction cells, expand, three filters, detail, empty, responsive; no collection",counts:expected.reduce((a,x)=>(a[x.state]=(a[x.state]??0)+1,a),{})}));
}finally{await browser.close();}
