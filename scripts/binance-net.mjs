// Connectivity preflight and route selection for Binance hosts.
//
// Routes, tried in this order, and the one used is ALWAYS printed (nothing switches silently):
//   1. direct   - the system resolver, then a TLS handshake for the REAL hostname
//   2. proxy    - HTTPS_PROXY / https_proxy, read explicitly from the environment (Node's fetch/https ignore it), via an HTTP CONNECT tunnel
//   3. doh      - an address from DNS-over-HTTPS, only ever trusted after its TLS handshake completes for the real hostname
// The URL keeps the hostname on every route, so SNI, the Host header and certificate validation stay correct. A wrong address fails the
// certificate check, so no resolver answer is trusted on its own.
//
// The proxy is an environment fact, never product code: set HTTPS_PROXY on a machine that needs it (a local VPN in system-proxy mode),
// leave it unset on a server and the direct route is used automatically.
//
// ============================================================================================================================
// HARD BOUNDARY - HTTP 451 (read this before changing anything here):
//   If ANY route gets HTTP 451 from Binance, STOP. Do not switch exit node, region, proxy or route until one is let through.
//   451 is Binance's own regional policy. Getting around it is overriding the service provider's decision. Repairing a broken
//   local network path (bad DNS, a dead proxy) is different: it only restores service Binance is already willing to give. A route that
//   returns 200 is the second case; a route that returns 451 is the first, and must fail loudly. `RegionBlockedError` is thrown and no
//   further route or host is tried.
// Likewise: on a rate limit (HTTP 418/429) stop and back off; never work around it.
// ============================================================================================================================
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns/promises";

export const BINANCE_HOSTS = {
  "fapi.binance.com": "/fapi/v1/ping",
  "dapi.binance.com": "/dapi/v1/ping",
  "api.binance.com": "/api/v3/ping",
};

/** Thrown when Binance answers HTTP 451 on any route. Never retried, never routed around. */
export class RegionBlockedError extends Error {
  constructor(host, route) {
    super(`HTTP 451 from ${host} via ${route}: Binance's own regional restriction. Stopping. Do not change exit node or route to get past it.`);
    this.name = "RegionBlockedError";
    this.status = 451;
    this.host = host;
  }
}

/** A dns.lookup replacement that always answers with `ip`. Newer Node calls lookup with { all: true } and then requires an array. */
export const fixedLookup = (ip) => (_host, options, cb) => (options && options.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4));

export const DOH_ENDPOINTS = [
  { name: "doh.pub", url: "https://doh.pub/dns-query" },
  { name: "dns.alidns.com", url: "https://dns.alidns.com/resolve" },
  { name: "cloudflare-dns.com", url: "https://cloudflare-dns.com/dns-query" },
  { name: "dns.google", url: "https://dns.google/resolve" },
];

/** A records from an application/dns-json answer. CNAME (type 5) and other records are ignored. */
export function parseDohAnswer(json) {
  if (!json || !Array.isArray(json.Answer)) return [];
  return json.Answer.filter((a) => a && a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(String(a.data))).map((a) => String(a.data));
}

/**
 * The proxy to use for `host`, from the environment, or null. Reads HTTPS_PROXY then https_proxy and honours NO_PROXY
 * (exact host, ".suffix", "suffix", or "*"). Only http:// proxies are supported. Node itself never reads these variables.
 */
export function proxyFromEnv(env = process.env, host = "") {
  const raw = env.HTTPS_PROXY ?? env.https_proxy;
  if (!raw) return null;
  const skip = String(env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const h = host.toLowerCase();
  if (skip.some((e) => e === "*" || h === e || (e.startsWith(".") ? h.endsWith(e) : h.endsWith("." + e)))) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:") return null;
  const auth = u.username ? "Basic " + Buffer.from(decodeURIComponent(u.username) + ":" + decodeURIComponent(u.password)).toString("base64") : null;
  return { hostname: u.hostname, port: Number(u.port) || 80, auth, label: `${u.protocol}//${u.hostname}:${u.port || 80}` };
}

/** Open an HTTP CONNECT tunnel through `proxy` to host:port. Resolves the raw tunnelled socket; rejects on any non-200 from the proxy. */
export function connectTunnel(proxy, host, port = 443, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...(proxy.auth ? { "Proxy-Authorization": proxy.auth } : {}) },
      timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(Object.assign(new Error("proxy CONNECT " + res.statusCode), { code: "EPROXY", status: res.statusCode }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("proxy timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

/**
 * An https.Agent that reaches the origin through an HTTP CONNECT tunnel. The request must go through an Agent: with `agent: false` Node
 * builds a default Agent and ignores a bare `createConnection` option, which silently connects to the system-resolved (bogus) address.
 */
class TunnelAgent extends https.Agent {
  constructor(proxy, host, timeoutMs) {
    super({ keepAlive: false });
    this.tunnel = { proxy, host, timeoutMs };
  }
  createConnection(_options, cb) {
    const { proxy, host, timeoutMs } = this.tunnel;
    connectTunnel(proxy, host, 443, timeoutMs).then(
      (sock) => cb(null, tls.connect({ socket: sock, servername: host })),
      (err) => cb(err),
    );
  }
}

const describe = (route) => (route.kind === "proxy" ? `proxy ${route.proxy.label}` : route.kind === "system" ? "system DNS" : `${route.kind} ${route.ip}`);

/**
 * One GET over a route. route: { kind: "system" } | { kind: "doh", ip } | { kind: "direct-ip", ip } | { kind: "proxy", proxy }.
 * Resolves { status, headers, text, json(), tcp }: `tcp` is true once a connection (or the proxy tunnel) existed, which separates
 * "unreachable / bogus address" from "reachable but the handshake was cut". HTTP 451 rejects with RegionBlockedError.
 */
export function request(route, host, path, { headers = {}, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let tcp = false;
    let agent;
    const base = { host, port: 443, method: "GET", path, timeout: timeoutMs, headers: { accept: "application/json", "user-agent": "AlphaRadarResearch/2.0", ...headers } };
    const opts =
      route.kind === "proxy"
        ? { ...base, agent: (agent = new TunnelAgent(route.proxy, host, Math.min(timeoutMs, 8000))) }
        : route.kind === "doh" || route.kind === "direct-ip"
          ? { ...base, lookup: fixedLookup(route.ip) }
          : base;
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode === 451) return reject(new RegionBlockedError(host, describe(route)));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text), tcp: true });
      });
    });
    req.on("socket", (sock) => {
      // A proxied socket only appears once the tunnel is up, so its mere existence means the connection was made.
      if (agent) tcp = true;
      else sock.once("connect", () => { tcp = true; });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e) => {
      if (agent) agent.destroy();
      reject(Object.assign(e, { tcp }));
    });
    req.on("close", () => agent && agent.destroy());
    req.end();
  });
}

/** Ping `host` over `route`. Resolves { ok, status, ms, error, tcp }. A 451 is NOT swallowed: it propagates as RegionBlockedError. */
export async function probeRoute(host, route, { timeoutMs = 6000 } = {}) {
  const started = Date.now();
  try {
    const r = await request(route, host, BINANCE_HOSTS[host] ?? "/", { timeoutMs });
    return { ok: r.status === 200, status: r.status, ms: Date.now() - started, error: null, tcp: true };
  } catch (e) {
    if (e instanceof RegionBlockedError) throw e;
    return { ok: false, status: null, ms: Date.now() - started, error: e.code || e.message, tcp: Boolean(e.tcp) };
  }
}

async function dohLookup(host, { endpoints = DOH_ENDPOINTS, timeoutMs = 6000 } = {}) {
  const results = await Promise.all(
    endpoints.map(async (e) => {
      try {
        const r = await fetch(`${e.url}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
        return parseDohAnswer(await r.json()).map((ip) => ({ ip, via: e.name }));
      } catch {
        return [];
      }
    }),
  );
  const seen = new Set();
  return results.flat().filter((c) => (seen.has(c.ip) ? false : seen.add(c.ip)));
}

async function systemLookup(host) {
  try {
    return (await dns.lookup(host, { family: 4, all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

const RESET = /ECONNRESET|EPIPE|ERR_SSL|socket hang up/;
const why = (p) => p.error ?? "HTTP " + p.status;

/**
 * Decide, per host, how to reach it. Dependencies are injectable so the decision logic is testable without a network:
 *   systemLookup(host) -> ips, dohLookup(host) -> [{ip,via}], probe(host, route) -> { ok, status, ms, error, tcp }, proxyFor(host) -> proxy|null.
 * Returns { routes, report }; routes[host] = { via, route, ms }. Throws with an explicit reason when a host cannot be reached by any route,
 * and throws RegionBlockedError (stopping everything) on the first HTTP 451.
 */
export async function preflight(hosts = Object.keys(BINANCE_HOSTS), deps = {}) {
  const sys = deps.systemLookup ?? systemLookup;
  const doh = deps.dohLookup ?? dohLookup;
  const check = deps.probe ?? probeRoute;
  const proxyFor = deps.proxyFor ?? ((h) => proxyFromEnv(process.env, h));
  const routes = {};
  const report = [];
  const failures = [];
  for (const host of hosts) {
    const notes = [];
    const resets = [];
    const attempt = async (route, label) => {
      const p = await check(host, route);
      if (p.ok) return p;
      notes.push(`${label} failed (${why(p)}${p.tcp ? ", tcp ok" : ""})`);
      if (p.tcp && RESET.test(String(p.error))) resets.push(label);
      return null;
    };

    const sysIps = await sys(host);
    if (!sysIps.length) notes.push("system DNS returned no address");
    for (const ip of sysIps.slice(0, 2)) {
      const p = await attempt({ kind: "direct-ip", ip }, `direct via system DNS ${ip}`);
      if (p) {
        routes[host] = { via: "direct", route: { kind: "system" }, ms: p.ms };
        report.push(`[net] ${host}: direct (system DNS ${ip}, ping ${p.ms}ms)`);
        break;
      }
    }
    if (routes[host]) continue;

    const proxy = proxyFor(host);
    if (proxy) {
      const p = await attempt({ kind: "proxy", proxy }, `proxy ${proxy.label}`);
      if (p) {
        routes[host] = { via: "proxy", route: { kind: "proxy", proxy }, ms: p.ms };
        report.push(`[net] ${host}: DIRECT PATH UNUSABLE, using the proxy from HTTPS_PROXY (${proxy.label}, ping ${p.ms}ms). ${notes.join("; ")}.`);
        continue;
      }
    } else {
      notes.push("no HTTPS_PROXY configured");
    }

    const candidates = (await doh(host)).filter((c) => !sysIps.includes(c.ip)).slice(0, 4);
    let chosen = null;
    for (const c of candidates) {
      const p = await attempt({ kind: "doh", ip: c.ip }, `DoH ${c.ip} (${c.via})`);
      if (p) {
        chosen = { ...c, ms: p.ms };
        break;
      }
    }
    if (chosen) {
      routes[host] = { via: "doh:" + chosen.via, route: { kind: "doh", ip: chosen.ip }, ms: chosen.ms };
      report.push(`[net] ${host}: LOCAL DNS RESOLUTION IS WRONG, not a Binance outage. ${notes.join("; ")}. DoH gave ${chosen.ip} (${chosen.via}) which completed TLS for ${host}. Using the DoH route for this run.`);
      continue;
    }

    const advice = resets.length
      ? `A connection was made and then the TLS handshake for ${host} was reset (${resets.join(", ")}). The address is reachable and the connection is cut once the server name is sent, so changing DNS will NOT fix this. It needs a different network path, chosen by the user (for example a working HTTPS_PROXY); this tool does not work around it.`
      : "";
    const line = `${host}: UNREACHABLE. ${notes.join("; ")}. ${advice}`.trim();
    failures.push(line);
    report.push(`[net] ${line}`);
  }
  if (failures.length) {
    const err = new Error("Binance connectivity preflight failed:\n  " + failures.join("\n  "));
    err.report = report;
    throw err;
  }
  return { routes, report };
}

/**
 * A GET helper that honours the routes chosen by `preflight`. Resolves { status, headers, text, json() }; HTTP errors other than 451 are
 * returned, not thrown. HTTP 451 rejects with RegionBlockedError and must stop the run. Rate limits (418/429) are the caller's to obey.
 */
export function createGet(routes) {
  return function get(url, { headers = {}, timeoutMs = 20000 } = {}) {
    const u = new URL(url);
    const chosen = routes[u.hostname];
    return request(chosen ? chosen.route : { kind: "system" }, u.hostname, u.pathname + u.search, { headers, timeoutMs });
  };
}
