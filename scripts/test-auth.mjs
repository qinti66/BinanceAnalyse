import assert from "node:assert/strict";
import {
  authEnabled, authMisconfigured, checkCredentials, cookieValue, isPublicPath, safeNext, signSession, verifySession, SESSION_TTL_MS,
} from "../lib/auth/session.ts";
import { isLoopback, parseVars, refusal, validPort } from "./start-guard.mjs";

const SECRET = "0123456789abcdef0123456789abcdef";
const env = { AUTH_USERNAME: "alice", AUTH_PASSWORD: "correct horse", SESSION_SECRET: SECRET };

// Enabled / misconfigured: fail closed, never open.
assert.equal(authEnabled({}), false, "no AUTH_USERNAME = login off (local development)");
assert.equal(authEnabled(env), true);
assert.equal(authMisconfigured(env), false);
assert.equal(authMisconfigured({ ...env, AUTH_PASSWORD: "" }), true);
assert.equal(authMisconfigured({ ...env, SESSION_SECRET: "short" }), true, "a short secret is refused");
assert.equal(authMisconfigured({ AUTH_USERNAME: "alice" }), true);
assert.equal(await checkCredentials({ ...env, SESSION_SECRET: "short" }, "alice", "correct horse"), false, "misconfigured never authenticates");
assert.equal(await checkCredentials({}, "", ""), false, "login off never authenticates");

// Credentials.
assert.equal(await checkCredentials(env, "alice", "correct horse"), true);
assert.equal(await checkCredentials(env, "alice", "wrong"), false);
assert.equal(await checkCredentials(env, "bob", "correct horse"), false);
assert.equal(await checkCredentials(env, "", ""), false);

// Session tokens.
const now = 1_700_000_000_000;
const token = await signSession(SECRET, now);
assert.equal(await verifySession(SECRET, token, now + 1000), true);
assert.equal(await verifySession(SECRET, token, now + SESSION_TTL_MS), false, "expired");
assert.equal(await verifySession(SECRET, token, now + SESSION_TTL_MS - 1), true);
assert.equal(await verifySession("another-secret-of-16chars", token, now + 1000), false, "signed with another secret");
const [exp, sig] = token.split(".");
assert.equal(await verifySession(SECRET, String(Number(exp) + 1) + "." + sig, now + 1000), false, "expiry tampered");
assert.equal(await verifySession(SECRET, exp + "." + sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"), now + 1000), false, "signature tampered");
for (const bad of [null, undefined, "", "abc", ".", "1.", ".sig", "x.y", exp]) assert.equal(await verifySession(SECRET, bad, now), false, String(bad));
assert.equal(await verifySession(undefined, token, now), false);
assert.equal(await verifySession("short", token, now), false);

// Cookie parsing and paths.
assert.equal(cookieValue("a=1; ar_session=tok.en; b=2"), "tok.en");
assert.equal(cookieValue("xar_session=1"), null);
assert.equal(cookieValue(null), null);
for (const p of ["/login", "/api/login", "/favicon.svg", "/_next/static/x.js", "/assets/a.js"]) assert.equal(isPublicPath(p), true, p);
for (const p of ["/", "/indicators", "/api/refresh", "/api/ai/test-connection", "/api/logout", "/login/", "/loginx", "/api/login/x"]) assert.equal(isPublicPath(p), false, p);

// Open-redirect guard.
assert.equal(safeNext("/indicators?x=1"), "/indicators?x=1");
for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "", null, undefined]) assert.equal(safeNext(bad), "/", String(bad));

// Launcher guard: a public listener needs the login; local does not.
assert.equal(isLoopback("127.0.0.1"), true);
assert.equal(isLoopback("localhost"), true);
assert.equal(isLoopback("0.0.0.0"), false);
assert.equal(isLoopback("43.160.255.62"), false);
assert.equal(refusal("127.0.0.1", {}), null);
assert.match(refusal("0.0.0.0", {}), /AUTH_USERNAME、AUTH_PASSWORD、SESSION_SECRET/);
assert.match(refusal("0.0.0.0", { AUTH_USERNAME: "a", AUTH_PASSWORD: "b" }), /SESSION_SECRET/);
assert.match(refusal("0.0.0.0", { AUTH_USERNAME: "a", AUTH_PASSWORD: "b", SESSION_SECRET: "short" }), /16/);
assert.equal(refusal("0.0.0.0", { AUTH_USERNAME: "a", AUTH_PASSWORD: "b", SESSION_SECRET: SECRET }), null);
assert.deepEqual(parseVars('# c\nA=1\n B = "two words" \nC=\'x\'\nbad line\n#D=4\n'), { A: "1", B: "two words", C: "x" });
assert.equal(validPort("8085"), true);
for (const bad of ["0", "65536", "abc", "", "80 85", "-1"]) assert.equal(validPort(bad), false, bad);
console.log("auth tests ok");
