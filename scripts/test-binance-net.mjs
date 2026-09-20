import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { preflight,parseDohAnswer,fixedLookup,proxyFromEnv,connectTunnel,RegionBlockedError } from "./binance-net.mjs";

const ok=(ms=10)=>({ok:true,status:200,ms,error:null,tcp:true});
const bad=(error,tcp=false)=>({ok:false,status:null,ms:5,error,tcp});
const PROXY={hostname:"127.0.0.1",port:23333,auth:null,label:"http://127.0.0.1:23333"};
const kind=(route)=>route.kind;

test("parseDohAnswer keeps only A records and ignores CNAMEs and junk",()=>{
 assert.deepEqual(parseDohAnswer({Answer:[{type:5,data:"x.cloudfront.net."},{type:1,data:"18.155.192.89"},{type:1,data:"not-an-ip"}]}),["18.155.192.89"]);
 assert.deepEqual(parseDohAnswer(null),[]);assert.deepEqual(parseDohAnswer({}),[]);
});

test("fixedLookup answers in the shape Node asks for, including { all: true }",()=>{
 let single,multi;
 fixedLookup("1.2.3.4")("h",{},(e,a,f)=>{single=[e,a,f];});
 fixedLookup("1.2.3.4")("h",{all:true},(e,a)=>{multi=[e,a];});
 assert.deepEqual(single,[null,"1.2.3.4",4]);assert.deepEqual(multi,[null,[{address:"1.2.3.4",family:4}]]);
});

test("proxyFromEnv reads the environment explicitly, honours NO_PROXY, and is absent when unset",()=>{
 assert.equal(proxyFromEnv({},"fapi.binance.com"),null,"unset ⇒ direct: this is what makes a server need no proxy");
 const p=proxyFromEnv({HTTPS_PROXY:"http://127.0.0.1:23333"},"fapi.binance.com");
 assert.deepEqual([p.hostname,p.port,p.auth,p.label],["127.0.0.1",23333,null,"http://127.0.0.1:23333"]);
 assert.equal(proxyFromEnv({https_proxy:"http://10.0.0.1:8080"},"x.com").port,8080,"lowercase form is accepted");
 assert.equal(proxyFromEnv({HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"localhost,.binance.com"},"fapi.binance.com"),null,".suffix in NO_PROXY");
 assert.equal(proxyFromEnv({HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"binance.com"},"fapi.binance.com"),null,"bare domain matches its subdomains");
 assert.equal(proxyFromEnv({HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"*"},"fapi.binance.com"),null);
 assert.ok(proxyFromEnv({HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"localhost,127.0.0.1,::1,.local"},"fapi.binance.com"),"the unrelated NO_PROXY of this machine does not disable it");
 assert.equal(proxyFromEnv({HTTPS_PROXY:"socks5://127.0.0.1:1"},"x.com"),null,"only http proxies are supported");
 assert.equal(proxyFromEnv({HTTPS_PROXY:"not a url"},"x.com"),null);
 assert.match(proxyFromEnv({HTTPS_PROXY:"http://user:p%40ss@10.0.0.1:8080"},"x.com").auth,/^Basic /);
 assert.ok(!proxyFromEnv({HTTPS_PROXY:"http://user:secret@10.0.0.1:8080"},"x.com").label.includes("secret"),"the label used in logs never carries credentials");
});

test("CONNECT tunnel: opens through a proxy, carries bytes, and rejects on any non-200",async()=>{
 const echo=net.createServer(s=>s.on("data",d=>s.write("echo:"+d)));await new Promise(r=>echo.listen(0,"127.0.0.1",r));
 let seen=null;
 const proxy=http.createServer();
 proxy.on("connect",(req,client)=>{seen=req.url;const h=req.url.split(":")[0];
  if(h==="denied.example"){client.end("HTTP/1.1 403 Forbidden\r\n\r\n");return;}
  const up=net.connect(echo.address().port,"127.0.0.1",()=>{client.write("HTTP/1.1 200 Connection Established\r\n\r\n");up.pipe(client);client.pipe(up);});});
 await new Promise(r=>proxy.listen(0,"127.0.0.1",r));
 const pr={hostname:"127.0.0.1",port:proxy.address().port,auth:null,label:"x"};
 try{
  const sock=await connectTunnel(pr,"fapi.binance.com",443);
  assert.equal(seen,"fapi.binance.com:443","the hostname, not an IP, is what the proxy is asked to reach");
  const got=await new Promise(r=>{sock.once("data",r);sock.write("hi");});assert.equal(String(got),"echo:hi");sock.destroy();
  await assert.rejects(connectTunnel(pr,"denied.example",443),e=>e.code==="EPROXY"&&e.status===403);
 }finally{proxy.close();echo.close();}
});

test("healthy direct DNS is used as-is; neither the proxy nor DoH is consulted",async()=>{
 let proxyCalls=0,dohCalls=0;
 const {routes,report}=await preflight(["fapi.binance.com"],{systemLookup:async()=>["18.155.192.89"],dohLookup:async()=>{dohCalls++;return [];},proxyFor:()=>{proxyCalls++;return PROXY;},probe:async()=>ok()});
 assert.equal(routes["fapi.binance.com"].via,"direct");assert.equal(proxyCalls+dohCalls,0);assert.match(report[0],/direct \(system DNS/);
});

test("a dead direct path falls through to the proxy, and the report says so explicitly",async()=>{
 const seen=[];
 const probe=async(h,route)=>{seen.push(kind(route));return route.kind==="proxy"?ok(300):bad("ETIMEDOUT");};
 const {routes,report}=await preflight(["fapi.binance.com"],{systemLookup:async()=>["31.13.76.99"],dohLookup:async()=>{throw new Error("DoH must not be needed");},proxyFor:()=>PROXY,probe});
 assert.deepEqual(seen,["direct-ip","proxy"]);
 assert.equal(routes["fapi.binance.com"].via,"proxy");assert.equal(routes["fapi.binance.com"].route.proxy.label,"http://127.0.0.1:23333");
 assert.match(report[0],/DIRECT PATH UNUSABLE, using the proxy from HTTPS_PROXY/);assert.match(report[0],/ETIMEDOUT/);
});

test("with no proxy configured the direct route is the only one tried before DoH, and that is reported",async()=>{
 const {routes,report}=await preflight(["fapi.binance.com"],{systemLookup:async()=>["31.13.76.99"],dohLookup:async()=>[{ip:"18.155.192.89",via:"doh.pub"}],proxyFor:()=>null,probe:async(h,route)=>route.kind==="doh"?ok(213):bad("ETIMEDOUT")});
 assert.equal(routes["fapi.binance.com"].via,"doh:doh.pub");assert.match(report[0],/LOCAL DNS RESOLUTION IS WRONG/);assert.match(report[0],/no HTTPS_PROXY configured/);assert.match(report[0],/Using the DoH route/);
});

test("DoH addresses equal to the system answer are not retried, and an unverified answer is never trusted",async()=>{
 const seen=[];
 await assert.rejects(preflight(["fapi.binance.com"],{systemLookup:async()=>["1.1.1.1"],dohLookup:async()=>[{ip:"1.1.1.1",via:"a"},{ip:"2.2.2.2",via:"b"}],proxyFor:()=>null,probe:async(h,route)=>{seen.push(route.ip);return bad("ETIMEDOUT");}}),/preflight failed/);
 assert.deepEqual(seen,["1.1.1.1","2.2.2.2"]);
});

test("TCP reachable but TLS reset with nothing else working: explicit failure, no route, no workaround offered",async()=>{
 const deps={systemLookup:async()=>["31.13.76.99"],dohLookup:async()=>[{ip:"18.155.192.89",via:"doh.pub"}],proxyFor:()=>null,probe:async(h,route)=>route.kind==="doh"?bad("ECONNRESET",true):bad("ETIMEDOUT")};
 let err;try{await preflight(["fapi.binance.com"],deps);}catch(e){err=e;}
 assert.ok(err,"must throw so a collector cannot start on a dead route");
 assert.match(err.message,/handshake for fapi\.binance\.com was reset/);assert.match(err.message,/changing DNS will NOT fix this/);assert.match(err.message,/chosen by the user/);
 assert.match(err.report[0],/UNREACHABLE/);
});

test("a proxy that answers but is itself broken falls through instead of masking the failure",async()=>{
 const probe=async(h,route)=>route.kind==="proxy"?bad("EPROXY"):bad("ETIMEDOUT");
 await assert.rejects(preflight(["fapi.binance.com"],{systemLookup:async()=>["9.9.9.9"],dohLookup:async()=>[],proxyFor:()=>PROXY,probe}),e=>/proxy http:\/\/127\.0\.0\.1:23333 failed \(EPROXY\)/.test(e.message));
});

test("HTTP 451 stops everything at once: no other route and no other host is tried",async()=>{
 const probed=[];
 const probe=async(h,route)=>{probed.push(h+":"+route.kind);if(route.kind==="proxy")throw new RegionBlockedError(h,"proxy http://127.0.0.1:23333");return bad("ETIMEDOUT");};
 let err;try{await preflight(["fapi.binance.com","dapi.binance.com"],{systemLookup:async()=>["9.9.9.9"],dohLookup:async()=>{probed.push("doh-lookup");return [{ip:"5.5.5.5",via:"x"}];},proxyFor:()=>PROXY,probe});}catch(e){err=e;}
 assert.ok(err instanceof RegionBlockedError);assert.equal(err.status,451);
 assert.match(err.message,/Binance's own regional restriction/);assert.match(err.message,/Do not change exit node/);
 assert.deepEqual(probed,["fapi.binance.com:direct-ip","fapi.binance.com:proxy"],"after the 451 nothing else was attempted: no DoH, no second host");
});

test("one bad host fails the whole preflight, so a partial route table is never used",async()=>{
 const probe=async(h)=>h==="fapi.binance.com"?ok():bad("ETIMEDOUT");
 await assert.rejects(preflight(["fapi.binance.com","dapi.binance.com"],{systemLookup:async()=>["9.9.9.9"],dohLookup:async()=>[],proxyFor:()=>null,probe}),/dapi\.binance\.com/);
});
