import html from "./index.html";

const API = "https://api.pntr.dev";
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

const MANIFEST = {
  name: "मेरे सेव किए ईमेल",
  short_name: "मेरे ईमेल",
  start_url: "/",
  display: "standalone",
  background_color: "#f6f6f7",
  theme_color: "#2563eb",
  icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
};
const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#2563eb"/><rect x="96" y="144" width="320" height="224" rx="28" fill="none" stroke="#fff" stroke-width="28"/><path d="M104 160l152 120 152-120" fill="none" stroke="#fff" stroke-width="28" stroke-linejoin="round"/></svg>';

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

const getItems = async (env) => JSON.parse((await env.SAVED.get("items")) || "[]");

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/manifest.json")
      return new Response(JSON.stringify(MANIFEST), { headers: { "content-type": "application/manifest+json" } });
    if (url.pathname === "/icon.svg")
      return new Response(ICON, { headers: { "content-type": "image/svg+xml" } });
    if (!url.pathname.startsWith("/api/"))
      return new Response(html, { headers: { "content-type": "text/html;charset=utf-8" } });

    if (!env.APP_PASSWORD || req.headers.get("x-app-key") !== env.APP_PASSWORD)
      return J({ error: "पासवर्ड गलत है" }, 401);

    try {
      if (!env.SAVED) return J({ error: "KV (SAVED) जुड़ा नहीं है" }, 500);

      if (url.pathname === "/api/config") return J({ domain: env.PNTR_DOMAIN });

      if (url.pathname === "/api/items" && req.method === "GET") return J(await getItems(env));

      if (url.pathname === "/api/items" && req.method === "POST") {
        const { addr, name, num } = await req.json();
        if (!addr || !addr.includes("@")) return J({ error: "पता सही नहीं है" }, 400);
        const items = await getItems(env);
        const auto = items.reduce((m, x) => Math.max(m, parseInt(x.num) || 0), 0) + 1;
        items.unshift({
          id: crypto.randomUUID(),
          name: String(name || "फोन").slice(0, 40),
          num: String(num || auto).slice(0, 12),
          addr: addr.trim().toLowerCase(),
        });
        await env.SAVED.put("items", JSON.stringify(items));
        return J(items);
      }

      if (url.pathname === "/api/items" && req.method === "DELETE") {
        const id = url.searchParams.get("id");
        const items = (await getItems(env)).filter((x) => x.id !== id);
        await env.SAVED.put("items", JSON.stringify(items));
        await env.SAVED.delete("h:" + id);
        return J(items);
      }

      if (url.pathname === "/api/inbox") {
        const want = (url.searchParams.get("addr") || "").toLowerCase();
        const hid = url.searchParams.get("id") || want;
        const histKey = "h:" + hid;

        const old = JSON.parse((await env.SAVED.get(histKey)) || "[]");
        const seen = new Set(old.map((m) => m.k));
        const newKeys = new Set();
        let total = 0;
        let keys = [];
        let warn = "";

        try {
          const id = await subId(env);
          const data = await pntr(env, `/api/subdomains/${id}/emails`);
          const arr = Array.isArray(data) ? data : data.emails || data.data || data.items || [];
          total = arr.length;
          keys = arr[0] ? Object.keys(arr[0]) : [];
          const rec = (m) =>
            JSON.stringify([m.to, m.recipient, m.to_address, m.recipients, m.rcpt, m.envelope_to]).toLowerCase();
          const mine = arr.filter((m) => rec(m).includes(want));
          let detail = 0;
          for (const m of mine.slice(0, 20)) {
            let body = m.text || m.body || m.body_text || m.text_body || m.html || m.snippet || m.preview || "";
            if (!body && m.id && detail < 5) {
              detail++;
              try {
                const d = await pntr(env, `/api/subdomains/${id}/emails/${m.id}`);
                body = d.text || d.body || d.body_text || d.text_body || d.html || "";
              } catch (e) {}
            }
            const from =
              typeof m.from === "object" && m.from ? m.from.address || m.from.email || "" : m.from || m.sender || "";
            const subject = m.subject || "";
            const date = m.date || m.created_at || m.received_at || m.timestamp || "";
            const plain = String(body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
            const otps = [...new Set((subject + " " + plain).match(/\b\d{4,8}\b/g) || [])];
            const k = [date, subject, from].join("|");
            if (!seen.has(k)) {
              seen.add(k);
              newKeys.add(k);
              old.push({ k, from, subject, date, otps, snippet: plain.slice(0, 300) });
            }
          }
        } catch (e) {
          warn = String(e.message || e);
        }

        old.sort((a, b) => (new Date(b.date) || 0) - (new Date(a.date) || 0));
        const all = old.slice(0, 50);
        if (newKeys.size) await env.SAVED.put(histKey, JSON.stringify(all));
        return J({ messages: all.map((m) => ({ ...m, isNew: newKeys.has(m.k) })), total, keys, warn });
      }

      return J({ error: "नहीं मिला" }, 404);
    } catch (e) {
      return J({ error: String(e.message || e) }, 500);
    }
  },
};
