import html from "./index.html";

const API = "https://api.pntr.dev";
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

async function pntr(env, path) {
  const r = await fetch(API + path, { headers: { Authorization: "Bearer " + env.PNTR_TOKEN } });
  if (!r.ok) throw new Error("PNTR ने " + r.status + " लौटाया");
  return r.json();
}

async function subId(env) {
  if (env.SUBDOMAIN_ID) return env.SUBDOMAIN_ID;
  const list = await pntr(env, "/api/subdomains");
  const arr = Array.isArray(list) ? list : list.subdomains || list.data || [];
  const host = String(env.PNTR_DOMAIN || "").toLowerCase();
  const label = host.split(".")[0];
  const hit =
    arr.find((s) => JSON.stringify(s).toLowerCase().includes(host)) ||
    arr.find((s) => String(s.name || "").toLowerCase() === label);
  if (!hit) throw new Error("PNTR में यह सबडोमेन नहीं मिला: " + host);
  return hit.id;
}

async function getItems(env) {
  return JSON.parse((await env.SAVED.get("items")) || "[]");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });
    }
    if (!env.APP_PASSWORD || req.headers.get("x-app-key") !== env.APP_PASSWORD) {
      return J({ error: "पासवर्ड गलत है" }, 401);
    }
    try {
      if (!env.SAVED) return J({ error: "KV (SAVED) जुड़ा नहीं है" }, 500);

      if (url.pathname === "/api/config") return J({ domain: env.PNTR_DOMAIN });

      if (url.pathname === "/api/items" && req.method === "GET") return J(await getItems(env));

      if (url.pathname === "/api/items" && req.method === "POST") {
        const { addr, name } = await req.json();
        if (!addr || !addr.includes("@")) return J({ error: "पता सही नहीं है" }, 400);
        const items = await getItems(env);
        const num = items.reduce((m, x) => Math.max(m, +x.num || 0), 0) + 1;
        items.unshift({
          id: crypto.randomUUID(),
          name: (name || "फोन").slice(0, 40),
          num,
          addr: addr.trim().toLowerCase(),
        });
        await env.SAVED.put("items", JSON.stringify(items));
        return J(items);
      }

      if (url.pathname === "/api/items" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        const items = (await getItems(env)).filter((x) => x.id !== id);
        await env.SAVED.put("items", JSON.stringify(items));
        return J(items);
      }

      if (url.pathname === "/api/inbox") {
        const want = (url.searchParams.get("addr") || "").toLowerCase();
        const id = await subId(env);
        const data = await pntr(env, `/api/subdomains/${id}/emails`);
        const arr = Array.isArray(data) ? data : data.emails || data.data || data.items || [];
        const rec = (m) =>
          JSON.stringify([m.to, m.recipient, m.to_address, m.recipients, m.rcpt, m.envelope_to]).toLowerCase();
        const mine = arr.filter((m) => rec(m).includes(want));
        const out = [];
        for (const m of mine.slice(0, 20)) {
          let body = m.text || m.body || m.body_text || m.text_body || m.html || m.snippet || m.preview || "";
          if (!body && m.id && out.length < 5) {
            try {
              const d = await pntr(env, `/api/subdomains/${id}/emails/${m.id}`);
              body = d.text || d.body || d.body_text || d.text_body || d.html || "";
            } catch (e) {}
          }
          out.push({
            from: typeof m.from === "object" && m.from ? m.from.address || m.from.email || "" : m.from || m.sender || "",
            subject: m.subject || "",
            date: m.date || m.created_at || m.received_at || m.timestamp || "",
            body,
          });
        }
        out.sort((a, b) => new Date(b.date) - new Date(a.date));
        return J({ messages: out, total: arr.length, keys: arr[0] ? Object.keys(arr[0]) : [] });
      }

      return J({ error: "नहीं मिला" }, 404);
    } catch (e) {
      return J({ error: String(e.message || e) }, 500);
    }
  },
};
