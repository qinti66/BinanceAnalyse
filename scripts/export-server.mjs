// A small download server for the exported data files, for when the operator cannot use scp. Node built-ins only; no dependencies.
//
// It serves ONLY the regular files directly inside one directory (data/export), never anything else and never a subdirectory. Every request needs HTTP
// Basic credentials (user "export", the password is EXPORT_TOKEN). Range requests work, so an interrupted download of a large file can be resumed
// (curl -C -). It is plain HTTP: the password and the file contents cross the network unencrypted, which is acceptable for public market data and
// a throwaway token, and is why the token must be a separate random value, never the site's own password.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { timingSafeEqual, createHash } from "node:crypto";

export const EXPORT_USER = "export";
export const MIN_TOKEN_LENGTH = 16;

const digest = (s) => createHash("sha256").update(s).digest();

export function basicOk(header, token) {
  if (!token || token.length < MIN_TOKEN_LENGTH || !header || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const userOk = timingSafeEqual(digest(decoded.slice(0, i)), digest(EXPORT_USER));
  const passOk = timingSafeEqual(digest(decoded.slice(i + 1)), digest(token));
  return userOk && passOk;
}

/** The file name a request path asks for, or null: one path segment only, no dot files, no separators, no encoded tricks. */
export function requestedName(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  if (!p.startsWith("/")) return null;
  const name = p.slice(1);
  if (!name || name.startsWith(".") || /[\\/\0]/.test(name) || name.includes("..")) return null;
  return name;
}

/** "bytes=a-b" | "bytes=a-" | "bytes=-n" against a size: { start, end } inclusive, null when there is no Range, "bad" when it cannot be satisfied. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "bad";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return "bad";
  return { start, end };
}

export function createExportServer({ dir, token }) {
  const root = resolve(dir);
  return createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(body);
    };
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed", { allow: "GET, HEAD" });
      if (!basicOk(req.headers.authorization, token)) return send(401, "authentication required", { "www-authenticate": 'Basic realm="export"' });
      if ((req.url ?? "/").split("?")[0] === "/") {
        const names = [];
        for (const e of await readdir(root, { withFileTypes: true })) if (e.isFile() && !e.name.startsWith(".")) names.push(e.name);
        const lines = [];
        for (const n of names.sort()) lines.push(`${n}\t${(await stat(join(root, n))).size}`);
        return send(200, lines.join("\n") + "\n");
      }
      const name = requestedName(req.url ?? "");
      if (!name) return send(404, "not found");
      const file = resolve(root, name);
      if (!file.startsWith(root + sep)) return send(404, "not found");
      let st;
      try {
        st = await stat(file);
      } catch {
        return send(404, "not found");
      }
      if (!st.isFile()) return send(404, "not found");
      const range = parseRange(req.headers.range, st.size);
      if (range === "bad") return send(416, "range not satisfiable", { "content-range": `bytes */${st.size}` });
      const headers = { "content-type": "application/octet-stream", "accept-ranges": "bytes", "cache-control": "no-store" };
      if (range) {
        res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${st.size}`, "content-length": range.end - range.start + 1 });
      } else {
        res.writeHead(200, { ...headers, "content-length": st.size });
      }
      if (req.method === "HEAD") return res.end();
      createReadStream(file, range ? { start: range.start, end: range.end } : {}).on("error", () => res.destroy()).pipe(res);
    } catch {
      send(500, "internal error");
    }
  });
}
