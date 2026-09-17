import http from "node:http";
import {spawn} from "node:child_process";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
let child=null,job={state:"idle",message:"手动更新已就绪；两个池的自动更新均关闭。"};
const allowed=o=>o==="http://127.0.0.1:5173"||o==="http://localhost:5173";
const server=http.createServer(async(req,res)=>{
 const origin=req.headers.origin;
 const send=(code,data)=>{res.writeHead(code,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify(data));};
 if(origin&&!allowed(origin)||!["127.0.0.1:8792","localhost:8792"].includes(req.headers.host??""))return send(403,{error:"Origin/Host rejected"});
 if(origin)res.setHeader("Access-Control-Allow-Origin",origin);res.setHeader("Vary","Origin");
 if(req.method==="OPTIONS"){res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");res.setHeader("Access-Control-Allow-Headers","Content-Type");res.writeHead(204);return res.end();}
 if(req.method==="GET"&&req.url==="/status")return send(200,job);
 if(req.method!=="POST"||req.url!=="/update")return send(404,{error:"Not found"});
 if(!allowed(origin)||req.headers["content-type"]!=="application/json")return send(403,{error:"Only the local UI may update"});
 if(child)return send(409,job);
 let body="",size=0;
 try{for await(const chunk of req){size+=chunk.length;if(size>1024)return send(413,{error:"Body too large"});body+=chunk;}
  const {scope}=JSON.parse(body);if(!["quality","ordinary","all"].includes(scope))return send(400,{error:"Invalid pool scope"});
  // Recheck after awaiting body to prevent two simultaneous requests from spawning two jobs.
  if(child)return send(409,job);
  job={state:"running",scope,message:"开始手动复核 "+scope,startedAt:new Date().toISOString()};
  child=spawn(process.execPath,[join(root,"scripts/update-copy-pools.mjs"),scope],{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let buffer="",lastError="",settled=false;
  child.stdout.on("data",d=>{buffer+=String(d);const lines=buffer.split(/\r?\n/);buffer=lines.pop()??"";for(const line of lines){try{const p=JSON.parse(line);if(p.message)job.message=p.message;}catch{}}});
  child.stderr.on("data",d=>{lastError=String(d).slice(-1000);});
  const finish=(code,error)=>{if(settled)return;settled=true;job={...job,state:code===0?"complete":"failed",message:code===0?"带单复核完成，已重新分池。":error||lastError||"更新失败，旧快照保留。",finishedAt:new Date().toISOString()};child=null;};
  child.once("error",e=>finish(1,String(e)));child.once("exit",code=>finish(code));
  return send(202,job);
 }catch{return send(400,{error:"Invalid request"});}
});
server.requestTimeout=10000;
server.listen(8792,"127.0.0.1",()=>console.log("Copy pool service: http://127.0.0.1:8792 (manual only)"));
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{child?.kill();server.close(()=>process.exit());});
