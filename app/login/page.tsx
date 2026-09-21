"use client";
import { useState } from "react";

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = new URLSearchParams(window.location.search).get("next");
      const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, next }) });
      const j = (await r.json()) as { ok?: boolean; error?: string; next?: string };
      if (r.ok && j.ok) window.location.href = j.next ?? "/";
      else setError(j.error ?? "登录失败");
    } catch {
      setError("网络错误，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 320, display: "grid", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Alpha Radar 登录</h1>
        <input aria-label="用户名" autoComplete="username" placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} required style={{ padding: 10 }} />
        <input aria-label="密码" type="password" autoComplete="current-password" placeholder="密码" value={password} onChange={(e) => setPassword(e.target.value)} required style={{ padding: 10 }} />
        {error && <div role="alert" style={{ color: "#c0392b", fontSize: 14 }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ padding: 10 }}>{busy ? "登录中…" : "登录"}</button>
      </form>
    </main>
  );
}
