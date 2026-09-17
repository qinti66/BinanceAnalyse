import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join,dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
let job={state:"idle",message:"手动更新就绪",startedAt:null,finishedAt:null,progress:null};
let child=null;
const allowedOrigin=o=>{try{const u=new URL(o);return u.protocol==="http:"&&["127.0.0.1","localhost"].includes(u.hostname)&&u.port==="5173";}catch{return false;}};
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 if(origin&&!allowedOrigin(origin)){res.writeHead(403);return res.end("Origin rejected");}
 if(!["127.0.0.1:8791","localhost:8791"].includes(req.headers.host??"")){res.writeHead(403);return res.end("Host rejected");}
 if(origin)res.setHeader("Access-Control-Allow-Origin",origin);
 res.setHeader("Vary","Origin");res.setHeader("Cache-Control","no-store");
 const send=(status,data)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(data));};
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");res.writeHead(204);return res.end();}
 if(req.method==="GET"&&req.url==="/status")return send(200,job);
 if(req.method==="GET"&&req.url==="/snapshot"){try{return send(200,JSON.parse(await readFile(join(root,"public","indicators","latest.json"),"utf8")));}catch{return send(404,{error:"尚无成功快照"});}}
 if(req.method!=="POST"||req.url!=="/update")return send(404,{error:"Not found"});
 if(!origin||!allowedOrigin(origin)||req.headers["content-type"]!=="application/json")return send(403,{error:"Only the local UI can start a manual update"});
 if(child)return send(409,{error:"已有更新任务正在运行",...job});
 job={state:"running",message:"正在拉取合约目录",startedAt:new Date().toISOString(),finishedAt:null,progress:null};
 child=spawn(process.execPath,[join(root,"scripts","update-indicators.mjs")],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let buffer="";
 child.stdout.on("data",d=>{buffer+=String(d);const lines=buffer.split(/\r?\n/);buffer=lines.pop()??"";for(const line of lines){try{const p=JSON.parse(line);if(p.phase){job.progress=p;job.message=p.phase==="contracts"?"已采集 "+p.completed+" / "+p.total+" 个合约":p.phase==="complete"?"采集完成，正在计算筛选结果":"正在获取全量合约";}}catch{/* non-progress output */}}});
 let lastError="";child.stderr.on("data",d=>{lastError=String(d).slice(-1000)});
 child.once("error",e=>{job={...job,state:"failed",message:String(e),finishedAt:new Date().toISOString()};child=null;});
 child.once("exit",code=>{job={...job,state:code===0?"complete":"failed",message:code===0?"全部更新与筛选完成":lastError||"采集或分析失败，保留上次可用快照",finishedAt:new Date().toISOString()};child=null;});
 return send(202,job);
});
server.listen(8791,"127.0.0.1",()=>console.log("Indicator update service: http://127.0.0.1:8791"));
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{child?.kill();server.close(()=>process.exit());});
