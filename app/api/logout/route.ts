import { COOKIE_NAME } from "../../../lib/auth/session";

export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json", "set-cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` },
  });
}
