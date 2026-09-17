import http from "node:http";
import {spawn} from "node:child_process";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const allowed=o=>["http://127.0.0.1:5173","http://localhost:5173"].includes(o);
let child=null,job={state:"idle",message:"广场手动更新就绪；自动更新关闭。"};
const server=http.createServer((req,res)=>{
 const origin=req.headers.origin;
 const send=(code,value)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
 if(!["127.0.0.1:8793","localhost:8793"].includes(req.headers.host)||origin&&!allowed(origin))return send(403,{error:"Origin/Host rejected"});
 if(origin)res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Vary","Origin");
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");res.writeHead(204);return res.end();}
 if(req.method==="GET"&&req.url==="/status")return send(200,job);
 if(req.method!=="POST"||req.url!=="/update")return send(404,{error:"Not found"});
 if(!allowed(origin)||req.headers["content-type"]!=="application/json")return send(403,{error:"Local UI only"});
 if(child)return send(409,job);
 req.resume();job={state:"running",message:"正在读取公开广场帖子…",startedAt:new Date().toISOString()};
 child=spawn(process.execPath,[join(root,"scripts/update-square.mjs")],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
 let buffer="",error="",settled=false;
 child.stdout.on("data",d=>{buffer+=String(d);const lines=buffer.split(/\r?\n/);buffer=lines.pop()??"";for(const line of lines){try{const p=JSON.parse(line);if(p.message)job.message=p.message;}catch{}}});
 child.stderr.on("data",d=>error=String(d).slice(-1500));
 const finish=(code,message)=>{if(settled)return;settled=true;job={...job,state:code===0?"complete":"failed",message:code===0?"广场采样完成，真实快照已保存。":message||error||"采集失败，旧快照保留。",finishedAt:new Date().toISOString()};child=null;};
 child.once("error",e=>finish(1,String(e)));child.once("exit",code=>finish(code));
 return send(202,job);
});
server.requestTimeout=10000;server.listen(8793,"127.0.0.1",()=>console.log("Square service: http://127.0.0.1:8793 (manual only)"));
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{child?.kill();server.close(()=>process.exit());});
