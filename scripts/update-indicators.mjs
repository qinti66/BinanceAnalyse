import { open,unlink,mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join,dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
await mkdir(join(root,"data","indicators"),{recursive:true});
const lockPath=join(root,"data","indicators","update.lock");
let lock;
try{lock=await open(lockPath,"wx");await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));}
catch{console.error("已有更新任务或遗留锁，请先检查 data/indicators/update.lock；不会覆盖其他任务。");process.exit(1);}
let child;
function launch(name){return new Promise((resolve,reject)=>{child=spawn(process.execPath,[join(root,"scripts",name)],{cwd:root,stdio:"inherit",windowsHide:true});child.once("error",reject);child.once("exit",code=>code===0?resolve():reject(Error(name+" exited "+code)));});}
for(const sig of ["SIGINT","SIGTERM"])process.on(sig,()=>{child?.kill();});
try{await launch("collect-indicators.mjs");await launch("enrich-indicator-spot.mjs");await launch("analyze-indicators.mjs");}
catch(e){console.error(String(e));process.exitCode=1;}
finally{await lock.close();await unlink(lockPath);}
