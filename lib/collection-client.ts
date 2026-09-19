"use client";
import {useCallback,useEffect,useRef,useState} from "react";
export const SERVICES={square:8793,indicators:8791,copy:8792};
export type CollectionModule=keyof typeof SERVICES;
type Job={state:string;message:string;startedAt?:string;finishedAt?:string};
export function useCollections(onComplete?:()=>void){
 const [jobs,setJobs]=useState<Partial<Record<CollectionModule,Job>>>({}),[local,setLocal]=useState(false);
 const callback=useRef(onComplete);callback.current=onComplete;
 const active=useRef(new Set<CollectionModule>()),starting=useRef(new Set<CollectionModule>()),mounted=useRef(false);
 const set=(m:CollectionModule,j:Job)=>{if(mounted.current)setJobs(v=>({...v,[m]:j}));};
 useEffect(()=>{
  mounted.current=true;const local=["127.0.0.1","localhost"].includes(location.hostname);setLocal(local);let stopped=false,inflight=false;
  const read=async(m:CollectionModule)=>{try{
   const r=await fetch("http://127.0.0.1:"+SERVICES[m]+"/status",{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error("HTTP "+r.status);const j=await r.json() as Job;
   if(stopped)return;
   if(j.state==="running")active.current.add(m);
   else if(active.current.delete(m))callback.current?.();
   set(m,j);
  }catch{if(!stopped){active.current.delete(m);set(m,{state:"offline",message:"本地更新服务未连接；旧快照仍保留。"});}}};
  if(local)void Promise.all((Object.keys(SERVICES) as CollectionModule[]).map(read));
  const timer=setInterval(async()=>{if(inflight||!active.current.size)return;inflight=true;try{await Promise.all([...active.current].map(read));}finally{inflight=false;}},1800);
  return()=>{stopped=true;mounted.current=false;clearInterval(timer);};
 },[]);
 const update=useCallback(async(modules:CollectionModule[])=>{
  if(!["127.0.0.1","localhost"].includes(location.hostname))return;
  for(const m of modules){
   if(active.current.has(m)||starting.current.has(m))continue;
   starting.current.add(m);set(m,{state:"running",message:"正在启动一次性采集…"});
   try{
    // "copy" 现在是 Hyperliquid 全量刷新（scripts/hyperliquid-service.mjs），不再需要区分优质/普通池分别更新的 scope 参数。
    const r=await fetch("http://127.0.0.1:"+SERVICES[m]+"/update",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}",signal:AbortSignal.timeout(5000)});
    const j=await r.json() as Job&{error?:string};if(r.status!==202&&r.status!==409)throw Error(j.error??"启动失败");
    active.current.add(m);set(m,j);
   }catch(e){set(m,{state:"offline",message:"启动结果未确认："+String((e as Error).message)+"；请检查服务状态，不要重复启动。"});}
   finally{starting.current.delete(m);}
  }
 },[]);
 return {jobs,local,update,busy:Object.values(jobs).some(j=>j.state==="running")};
}
