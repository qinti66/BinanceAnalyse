// Local-only browser QA. Pass an installed Playwright entry point; no dependencies are installed.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const base=process.argv[3]??"http://127.0.0.1:5173";
const browser=await chromium.launch({headless:true,channel:"msedge"});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1080}});
 const errors=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto(base+"/square");
 await page.waitForLoadState("networkidle");
 await page.getByRole("button",{name:"重算演示样本"}).waitFor();
 const table=page.locator(".sq-tablecard tbody");
 assert.equal(await table.locator("tr").count(),8);
 for(const [label,count] of [["有有效仓位加分",2],["方向矛盾",1],["已平仓",1],["截图／仅自述",1],["发帖后开仓／补证",1],["证据过期",1],["证据不足",1],["全部观点",8]]){
   await page.getByRole("combobox",{name:"证据状态"}).click();
   await page.getByRole("option",{name:label,exact:true}).click();
   await page.waitForFunction(n=>document.querySelectorAll(".sq-tablecard tbody tr").length===n,count);
   assert.equal(await table.locator("tr").count(),count,label);
 }
 await page.getByRole("button",{name:"查看 演示作者 · 同向持仓 的证据",exact:true}).click();
 assert.ok(await page.getByRole("region",{name:"作者证据详情"}).isVisible());
 assert.ok((await page.locator(".sq-detail").innerText()).includes("1.62"));
 await page.getByRole("button",{name:"收起明细"}).click();
 await page.getByRole("textbox",{name:"搜索作者或观点"}).fill("没有这个作者");
 await page.waitForFunction(()=>document.querySelectorAll(".sq-tablecard tbody tr").length===0);
 assert.equal(await table.locator("tr").count(),0);
 await page.getByRole("button",{name:"清除筛选"}).click();
 await page.getByRole("button",{name:/ETH.*位作者/}).click();
 await page.waitForFunction(()=>document.querySelectorAll(".sq-tablecard tbody tr").length===2);
 assert.equal(await table.locator("tr").count(),2);
 assert.ok((await table.innerText()).includes("占账户 未公开"));
 await page.getByRole("button",{name:/SOL.*位作者/}).click();
 await page.waitForFunction(()=>document.querySelectorAll(".sq-tablecard tbody tr").length===3);
 assert.equal(await table.locator("tr").count(),3);
 await page.getByRole("button",{name:/BTC.*位作者/}).click();
 await page.getByRole("button",{name:"重算演示样本"}).click();
 await page.getByRole("status").filter({hasText:"演示分析已完成"}).waitFor();
 assert.ok((await page.locator(".sq-status").innerText()).includes("分析 v2"));
 await page.getByRole("tab",{name:"真实数据 · 未接入"}).click();
 await page.locator(".sq-empty").waitFor();
 assert.equal(await page.locator(".sq-tablecard").count(),0);
 await page.getByRole("button",{name:"检查数据接入"}).click();
 assert.ok((await page.getByRole("status").innerText()).includes("没有调用币安接口"));
 await page.getByRole("tab",{name:"演示样本",exact:true}).click();
 await mkdir("artifacts/square",{recursive:true});
 await page.screenshot({path:"artifacts/square/desktop.png",fullPage:true});
 await page.getByRole("button",{name:"查看 演示作者 · 同向持仓 的证据",exact:true}).click();
 await page.screenshot({path:"artifacts/square/evidence.png",fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=390),"page should not overflow on mobile");
 await page.screenshot({path:"artifacts/square/mobile.png",fullPage:true});
 await page.goto(base+"/");
 assert.ok(await page.getByRole("link",{name:"广场情绪 · 仓位证据"}).isVisible());
 assert.deepEqual(errors,[]);
 console.log("PASS: filters, evidence breakdown, search, coins, demo refresh, live empty state, navigation, mobile layout; no browser exceptions.");
}finally{await browser.close();}
