// Only this service holds the long-lived TURN key. Browsers receive expiring
// connection credentials, never the Cloudflare API token.
export async function handle(request, env, upstream = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return new Response("OK");
  if (url.pathname !== "/ice") return new Response("Not found", {status:404});
  const origin = request.headers.get("Origin");
  if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) return new Response("Forbidden", {status:403});
  const headers = {"Access-Control-Allow-Origin":origin, "Vary":"Origin", "Cache-Control":"no-store"};
  if (request.method === "OPTIONS") return new Response(null, {status:204, headers:{...headers,"Access-Control-Allow-Methods":"GET, OPTIONS"}});
  if (request.method !== "GET") return new Response("Method not allowed", {status:405,headers});
  const fail = (status, error) => Response.json({error}, {status,headers});
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN || !env.TURN_RATE_LIMITER) return fail(503,"Relay not configured");
  // Origin checks are not authentication. The edge rate limit is also required
  // because a public site must expose this endpoint to its visitors.
  const limit = await env.TURN_RATE_LIMITER.limit({key:request.headers.get("CF-Connecting-IP") || "unknown"});
  if (!limit.success) return fail(429,"Please wait before retrying");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await upstream("https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(env.CF_TURN_KEY_ID) + "/credentials/generate-ice-servers", {
      method:"POST", headers:{"Authorization":"Bearer " + env.CF_TURN_API_TOKEN, "Content-Type":"application/json"},
      body:JSON.stringify({ttl:86400}), signal:abort.signal
    });
    if (!response.ok) return fail(502,"Relay credentials unavailable");
    const data = await response.json();
    const iceServers = (Array.isArray(data.iceServers) ? data.iceServers : []).map(server => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(u => typeof u === "string" && /^(stun|turn|turns):/.test(u) && !/:53(?:\?|$)/.test(u));
      if (!urls.length) return null;
      const result = {urls};
      if (urls.some(u => /^turns?:/.test(u))) {
        if (typeof server.username !== "string" || typeof server.credential !== "string") return null;
        result.username = server.username; result.credential = server.credential;
      }
      return result;
    }).filter(Boolean);
    if (!iceServers.some(s => s.urls.some(u => /^turns?:/.test(u)))) return fail(502,"No relay available");
    return Response.json({iceServers}, {headers});
  } catch { return fail(502,"Relay credentials unavailable"); }
  finally { clearTimeout(timer); }
}
export default {fetch(request, env) {return handle(request, env);} };
