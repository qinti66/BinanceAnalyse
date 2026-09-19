import test from "node:test";
import assert from "node:assert/strict";
import {checkBaseUrl,complete,parseConfig} from "../lib/ai/providers.ts";
import {parseStore} from "../lib/ai/config-store.ts";
const resp=(status,body)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const cfg=(o={})=>({id:"a",name:"t",protocol:"openai",baseUrl:"https://api.example.com/v1",model:"m",apiKey:"sk-secret-123",...o});
test("baseUrl: https ok, http only for localhost, no credentials, trailing slash trimmed",()=>{
 assert.equal(checkBaseUrl("https://api.example.com/v1/"),"https://api.example.com/v1");
 assert.equal(checkBaseUrl("http://localhost:11434/v1"),"http://localhost:11434/v1");
 assert.throws(()=>checkBaseUrl("http://api.example.com"),/https/);
 assert.throws(()=>checkBaseUrl("http://192.168.1.5:8000"),/https/);
 assert.throws(()=>checkBaseUrl("https://user:pw@api.example.com"),/账号密码/);
 assert.throws(()=>checkBaseUrl("not a url"),/格式/);
});
test("openai-compatible request shape and response parsing",async()=>{
 let seen;
 const f=async(url,init)=>{seen={url,init};return resp(200,{choices:[{message:{content:" OK "}}]});};
 assert.equal(await complete(cfg(),{system:"s",user:"u"},f),"OK");
 assert.equal(seen.url,"https://api.example.com/v1/chat/completions");
 assert.equal(seen.init.headers.authorization,"Bearer sk-secret-123");
 assert.deepEqual(JSON.parse(seen.init.body).messages.map(m=>m.role),["system","user"]);
});
test("anthropic request shape and response parsing",async()=>{
 let seen;
 const f=async(url,init)=>{seen={url,init};return resp(200,{content:[{type:"text",text:"你好"}]});};
 assert.equal(await complete(cfg({protocol:"anthropic",baseUrl:"https://api.anthropic.com"}),{system:"s",user:"u"},f),"你好");
 assert.equal(seen.url,"https://api.anthropic.com/v1/messages");
 assert.equal(seen.init.headers["x-api-key"],"sk-secret-123");
});
test("errors never leak the key, empty replies are errors, missing key/model rejected",async()=>{
 await assert.rejects(complete(cfg(),{system:"s",user:"u"},async()=>resp(401,{error:{message:"bad key sk-secret-123"}})),e=>e.status===401&&!e.message.includes("sk-secret-123")&&e.message.includes("***"));
 await assert.rejects(complete(cfg(),{system:"s",user:"u"},async()=>resp(200,{choices:[{message:{content:""}}]})),/空内容/);
 await assert.rejects(complete(cfg({protocol:"anthropic",apiKey:""}),{system:"s",user:"u"},async()=>resp(200,{})),/API Key/);
 await assert.rejects(complete(cfg({model:" "}),{system:"s",user:"u"},async()=>resp(200,{})),/模型/);
 // local OpenAI-compatible models may run without a key
 assert.equal(await complete(cfg({apiKey:"",baseUrl:"http://localhost:11434/v1"}),{system:"s",user:"u"},async(u,i)=>{assert.equal(i.headers.authorization,undefined);return resp(200,{choices:[{message:{content:"ok"}}]});}),"ok");
});
test("parseConfig validates shape; parseStore drops malformed entries and repairs activeId",()=>{
 assert.throws(()=>parseConfig(null),/缺少/);
 assert.throws(()=>parseConfig({protocol:"x",baseUrl:"",model:"",apiKey:""}),/协议/);
 assert.equal(parseConfig({...cfg(),model:" m "}).model,"m");
 const s=parseStore(JSON.stringify({configs:[cfg(),{id:5}],activeId:"gone"}));
 assert.equal(s.configs.length,1);assert.equal(s.activeId,"a");
 assert.deepEqual(parseStore("{{bad").configs,[]);
});
test("network failures become readable Chinese errors, not opaque runtime text",async()=>{
 await assert.rejects(complete(cfg(),{system:"s",user:"u"},async()=>{throw new TypeError("fetch failed");}),/无法连接到 api\.example\.com/);
 await assert.rejects(complete(cfg(),{system:"s",user:"u"},async()=>{const e=new Error("x");e.name="TimeoutError";throw e;}),/超时/);
});
