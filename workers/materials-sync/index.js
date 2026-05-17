const SM8_MATERIALS_URL = "https://api.servicem8.com/api_1.0/material.json";
const SM8_COMPANY_SEARCH_URL = "https://api.servicem8.com/api_1.0/company.json";
// https://developer.servicem8.com/docs/authentication
const SM8_TOKEN_URL = "https://go.servicem8.com/oauth/access_token";
const SM8_CLIENT_ID = "781230";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 min
const MATERIALS_TTL_SECONDS = 86400;
const CLIENT_KEY_PREFIX = "client:";
const MATERIALS_KEY_PREFIX = "materials:";
const PHOTO_PREFIX = (uuid) => `clients/${uuid}/photos/`;
const SENSITIVE_CLIENT_FIELDS = ["access_token", "refresh_token", "expires_at", "token_updated_at"];

const ALLOWED_ORIGINS = new Set([
  "https://rafter.deepgreensea.au",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://rafter.deepgreensea.au";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, x-rafter-secret",
    "vary": "Origin",
  };
}

function withCors(request, response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function sanitizeClient(config) {
  if (!config || typeof config !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SENSITIVE_CLIENT_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerCheck(request, env) {
  const expected = env.RAFTER_WORKER_SECRET;
  if (!expected) {
    return json({ error: "server_misconfigured", detail: "RAFTER_WORKER_SECRET not set" }, { status: 500 });
  }
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !constantTimeEqual(m[1], expected)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function readClient(env, uuid) {
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_KEY_PREFIX + uuid);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeClient(env, uuid, config) {
  await env.RAFTER_CLIENTS.put(CLIENT_KEY_PREFIX + uuid, JSON.stringify(config));
}

async function refreshTokenIfNeeded(uuid, env) {
  const config = await readClient(env, uuid);
  if (!config) throw new Error(`client_not_found: ${uuid}`);

  if (!config.access_token && !config.refresh_token) {
    throw new Error(`no_tokens: ${uuid} — complete OAuth flow via /setup first`);
  }

  const expiresAt = config.expires_at ? new Date(config.expires_at).getTime() : 0;
  const needsRefresh = !config.access_token
    || !expiresAt
    || Date.now() + TOKEN_REFRESH_BUFFER_MS >= expiresAt;

  if (!needsRefresh) return config.access_token;

  if (!config.refresh_token) {
    throw new Error(`token_expired_no_refresh_token: ${uuid} — re-authorise via /setup`);
  }
  if (!env.SERVICEM8_CLIENT_SECRET) {
    throw new Error("SERVICEM8_CLIENT_SECRET worker secret is not set");
  }

  const res = await fetch(SM8_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: config.refresh_token,
      client_id: SM8_CLIENT_ID,
      client_secret: env.SERVICEM8_CLIENT_SECRET,
    }).toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`sm8_token_refresh_failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const tokens = await res.json();
  if (!tokens.access_token) {
    throw new Error(`sm8_token_refresh_invalid_response: ${JSON.stringify(tokens).slice(0, 200)}`);
  }

  config.access_token = tokens.access_token;
  if (tokens.refresh_token) config.refresh_token = tokens.refresh_token;
  if (tokens.expires_in) {
    config.expires_at = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }
  config.token_updated_at = new Date().toISOString();

  await writeClient(env, uuid, config);
  console.log(JSON.stringify({ event: "token_refreshed", uuid, expires_at: config.expires_at }));

  return config.access_token;
}

async function fetchMaterials(accessToken) {
  const res = await fetch(SM8_MATERIALS_URL, {
    headers: { "authorization": `Bearer ${accessToken}`, "accept": "application/json" },
  });
  let data = null;
  let bodyText = null;
  if (res.ok) {
    try { data = await res.json(); } catch { bodyText = await res.text(); }
  } else {
    try { bodyText = await res.text(); } catch { /* ignore */ }
  }
  return { ok: res.ok, status: res.status, data, bodyText };
}

async function writeMaterials(env, uuid, data) {
  await env.RAFTER_CLIENTS.put(
    MATERIALS_KEY_PREFIX + uuid,
    JSON.stringify(data),
    { expirationTtl: MATERIALS_TTL_SECONDS },
  );
}

function summariseMaterials(data) {
  if (Array.isArray(data)) {
    return {
      shape: "array",
      count: data.length,
      sample_fields: data.length ? Object.keys(data[0]).slice(0, 30) : [],
    };
  }
  if (data && typeof data === "object") {
    return {
      shape: "object",
      count: 1,
      sample_fields: Object.keys(data).slice(0, 30),
    };
  }
  return { shape: typeof data, count: 0, sample_fields: [] };
}

async function handleStoreToken(request, env) {
  const auth = bearerCheck(request, env);
  if (auth) return auth;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, { status: 400 }); }

  const { uuid, access_token, refresh_token, expires_at } = body || {};
  if (!uuid || typeof uuid !== "string") {
    return json({ error: "missing_field", field: "uuid" }, { status: 400 });
  }
  if (!access_token || typeof access_token !== "string") {
    return json({ error: "missing_field", field: "access_token" }, { status: 400 });
  }

  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });

  config.access_token = access_token;
  if (refresh_token !== undefined) config.refresh_token = refresh_token;
  if (expires_at !== undefined) config.expires_at = expires_at;
  config.token_updated_at = new Date().toISOString();

  await writeClient(env, uuid, config);
  return json({ ok: true, uuid, token_updated_at: config.token_updated_at });
}

async function handleRenderEmail(request, env) {
  const secret = env.RAFTER_INTERNAL_SECRET;
  if (!secret) {
    return json({ error: "server_misconfigured", detail: "RAFTER_INTERNAL_SECRET not set" }, { status: 500 });
  }
  const provided = request.headers.get("x-rafter-secret") || "";
  if (!constantTimeEqual(provided, secret)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, { status: 400 }); }

  const { uuid, client_name, job_address, quote_ref, total } = body || {};
  if (!uuid || typeof uuid !== "string") {
    return json({ error: "missing_field", field: "uuid" }, { status: 400 });
  }

  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });

  const template = config.email_template || "";
  const html = template
    .replace(/\{client_name\}/g, client_name || "")
    .replace(/\{job_address\}/g, job_address || "")
    .replace(/\{quote_ref\}/g, quote_ref || "")
    .replace(/\{total\}/g, total || "");

  return json({ html });
}

async function handleRefreshMaterials(url, env) {
  const uuid = url.searchParams.get("uuid");
  if (!uuid) return json({ error: "missing_param", param: "uuid" }, { status: 400 });

  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });

  let accessToken;
  try {
    accessToken = await refreshTokenIfNeeded(uuid, env);
  } catch (e) {
    return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 });
  }

  const result = await fetchMaterials(accessToken);
  if (!result.ok) {
    return json(
      { error: "sm8_error", status: result.status, body: (result.bodyText || "").slice(0, 500) },
      { status: 502 },
    );
  }

  await writeMaterials(env, uuid, result.data);
  const summary = summariseMaterials(result.data);
  return json({ ok: true, uuid, ...summary, ttl_seconds: MATERIALS_TTL_SECONDS });
}

async function handleCopyR2Photos(request, url, env) {
  const secret = env.RAFTER_INTERNAL_SECRET;
  if (!secret) return json({ error: "server_misconfigured" }, { status: 500 });
  const provided = request.headers.get("x-rafter-secret") || "";
  if (!constantTimeEqual(provided, secret)) return json({ error: "unauthorized" }, { status: 401 });

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return json({ error: "missing_param", params: "from,to" }, { status: 400 });
  if (from === to) return json({ error: "same_uuid" }, { status: 400 });
  if (!env.RAFTER_ASSETS) return json({ error: "r2_not_bound" }, { status: 500 });

  const srcPrefix = `clients/${from}/photos/`;
  const dstPrefix = `clients/${to}/photos/`;

  const keys = [];
  let cursor;
  do {
    const page = await env.RAFTER_ASSETS.list({ prefix: srcPrefix, cursor, limit: 1000 });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  let copied = 0;
  let failed = 0;
  const BATCH = 20;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async (srcKey) => {
      const dstKey = dstPrefix + srcKey.slice(srcPrefix.length);
      const obj = await env.RAFTER_ASSETS.get(srcKey);
      if (!obj) throw new Error("not_found");
      const buf = await obj.arrayBuffer();
      await env.RAFTER_ASSETS.put(dstKey, buf, { httpMetadata: obj.httpMetadata });
    }));
    for (const r of results) r.status === "fulfilled" ? copied++ : failed++;
  }

  return json({ ok: true, from, to, copied, failed, total: keys.length });
}


async function listClientUuids(env) {
  const uuids = [];
  let cursor = undefined;
  do {
    const page = await env.RAFTER_CLIENTS.list({ prefix: CLIENT_KEY_PREFIX, cursor });
    for (const k of page.keys) {
      const uuid = k.name.slice(CLIENT_KEY_PREFIX.length);
      if (uuid) uuids.push(uuid);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return uuids;
}

async function syncOneClient(env, uuid) {
  const config = await readClient(env, uuid);
  if (!config) return { uuid, status: "skipped", reason: "config_not_found" };

  let accessToken;
  try {
    accessToken = await refreshTokenIfNeeded(uuid, env);
  } catch (e) {
    return { uuid, status: "skipped", reason: `token_refresh_failed: ${e.message}` };
  }

  const result = await fetchMaterials(accessToken);
  if (!result.ok) return { uuid, status: "failed", reason: `sm8_${result.status}` };

  await writeMaterials(env, uuid, result.data);
  const summary = summariseMaterials(result.data);
  return { uuid, status: "ok", count: summary.count, shape: summary.shape };
}

async function handleReadClient(uuid, env) {
  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });
  const safe = sanitizeClient(config);
  return json({ ok: true, uuid, client: safe });
}

async function handleReadMaterials(uuid, env) {
  const raw = await env.RAFTER_CLIENTS.get(MATERIALS_KEY_PREFIX + uuid);
  if (!raw) return json({ error: "materials_not_cached", uuid, hint: "call /refresh-materials first" }, { status: 404 });
  let data;
  try { data = JSON.parse(raw); }
  catch { return json({ error: "materials_corrupt", uuid }, { status: 500 }); }
  return json({ ok: true, uuid, materials: data });
}

async function handleListPhotos(uuid, env) {
  if (!env.RAFTER_ASSETS) return json({ error: "r2_not_bound" }, { status: 500 });
  const prefix = PHOTO_PREFIX(uuid);
  const categories = new Map();
  let cursor;
  do {
    const page = await env.RAFTER_ASSETS.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rest = obj.key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) continue;
      const category = rest.slice(0, slash);
      const filename = rest.slice(slash + 1);
      if (!filename || filename.includes("/")) continue;
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push({ key: obj.key, filename });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const sorted = [...categories.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, photos]) => ({ name, photos: photos.sort((a, b) => a.filename.localeCompare(b.filename)) }));
  return json({ ok: true, uuid, categories: sorted });
}

async function handleGetPhoto(url, env) {
  if (!env.RAFTER_ASSETS) return new Response("r2_not_bound", { status: 500 });
  const uuid = url.searchParams.get("uuid");
  const key = url.searchParams.get("key");
  if (!uuid || !key) return new Response("missing_params", { status: 400 });
  if (!key.startsWith(PHOTO_PREFIX(uuid))) return new Response("forbidden", { status: 403 });
  const obj = await env.RAFTER_ASSETS.get(key);
  if (!obj) return new Response("not_found", { status: 404 });
  const mime = obj.httpMetadata?.contentType || mimeFromKey(key);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": mime,
      "cache-control": "public, max-age=3600",
    },
  });
}

function mimeFromKey(key) {
  const ext = key.toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" })[ext] || "application/octet-stream";
}

async function handleBrandAsset(key, env) {
  if (!env.RAFTER_ASSETS) return new Response("r2_not_bound", { status: 500 });
  if (!/^[a-z0-9_.-]+$/i.test(key)) return new Response("invalid_key", { status: 400 });
  const obj = await env.RAFTER_ASSETS.get(`brand/${key}`);
  if (!obj) return new Response("not_found", { status: 404 });
  const mime = obj.httpMetadata?.contentType || mimeFromKey(key);
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": mime,
      "cache-control": "public, max-age=86400",
    },
  });
}

async function handleClientLogo(uuid, env) {
  if (!env.RAFTER_ASSETS) return new Response("r2_not_bound", { status: 500 });
  for (const ext of ["png", "jpg", "jpeg"]) {
    const obj = await env.RAFTER_ASSETS.get(`clients/${uuid}/logo.${ext}`);
    if (obj) {
      const mime = obj.httpMetadata?.contentType || mimeFromKey(`logo.${ext}`);
      return new Response(obj.body, {
        status: 200,
        headers: { "content-type": mime, "cache-control": "public, max-age=3600" },
      });
    }
  }
  return new Response("not_found", { status: 404 });
}

async function handleSm8Staff(url, env) {
  const uuid = url.searchParams.get("uuid");
  if (!uuid) return json({ error: "missing_param", param: "uuid" }, { status: 400 });
  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });
  let accessToken;
  try {
    accessToken = await refreshTokenIfNeeded(uuid, env);
  } catch (e) {
    return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 });
  }
  const res = await fetch("https://api.servicem8.com/api_1.0/staff.json", {
    headers: { "authorization": `Bearer ${accessToken}`, "accept": "application/json" },
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return json({ error: "sm8_error", status: res.status, body: bodyText.slice(0, 500) }, { status: 502 });
  }
  let data;
  try { data = await res.json(); } catch { return json({ error: "sm8_invalid_json" }, { status: 502 }); }
  const list = Array.isArray(data) ? data : [];
  const staff = list
    .filter((s) => s && s.active != 0)
    .map((s) => ({ uuid: s.uuid, first: s.first, last: s.last, email: s.email || "", type: s.type || "" }));
  return json({ ok: true, staff });
}

async function handleResolveSlug(slug, env) {
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
    return json({ error: "invalid_slug" }, { status: 400 });
  }
  const uuid = await env.RAFTER_CLIENTS.get(`slug:${slug}`);
  if (!uuid) return json({ error: "slug_not_found", slug }, { status: 404 });
  return json({ ok: true, slug, uuid });
}

async function handleSm8Search(url, env) {
  const uuid = url.searchParams.get("uuid");
  const q = (url.searchParams.get("q") || "").trim();
  if (!uuid) return json({ error: "missing_param", param: "uuid" }, { status: 400 });
  if (q.length < 3) return json({ ok: true, results: [], note: "query_too_short" });
  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });

  let accessToken;
  try {
    accessToken = await refreshTokenIfNeeded(uuid, env);
  } catch (e) {
    return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 });
  }

  const sm8 = new URL(SM8_COMPANY_SEARCH_URL);
  sm8.searchParams.set("search", q);
  const res = await fetch(sm8.toString(), {
    headers: { "authorization": `Bearer ${accessToken}`, "accept": "application/json" },
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    return json({ error: "sm8_error", status: res.status, body: bodyText.slice(0, 500) }, { status: 502 });
  }
  let data;
  try { data = await res.json(); } catch { return json({ error: "sm8_invalid_json" }, { status: 502 }); }
  const list = Array.isArray(data) ? data : [];
  const ql = q.toLowerCase();
  const results = list
    .filter((c) => c && c.active != 0 && (c.name || "").toLowerCase().includes(ql))
    .slice(0, 10)
    .map((c) => ({
      uuid: c.uuid,
      name: c.name,
      address: c.address || [c.address_street, c.address_city, c.address_state, c.address_postcode].filter(Boolean).join(", "),
      email: c.email || c.billing_email || "",
    }));
  return json({ ok: true, results });
}

async function runScheduledSync(env) {
  const uuids = await listClientUuids(env);
  const results = [];
  for (const uuid of uuids) {
    try {
      results.push(await syncOneClient(env, uuid));
    } catch (err) {
      results.push({ uuid, status: "failed", reason: `exception: ${err.message}` });
    }
  }
  const ok = results.filter((r) => r.status === "ok");
  const skipped = results.filter((r) => r.status === "skipped");
  const failed = results.filter((r) => r.status === "failed");
  console.log(JSON.stringify({
    event: "materials_sync",
    total: uuids.length,
    ok: ok.length,
    skipped: skipped.length,
    failed: failed.length,
    results,
  }));
  return { total: uuids.length, ok, skipped, failed };
}

async function handleClientConfig(request, url, env) {
  const secret = env.RAFTER_INTERNAL_SECRET;
  if (!secret) {
    return json({ error: "server_misconfigured", detail: "RAFTER_INTERNAL_SECRET not set" }, { status: 500 });
  }
  const provided = request.headers.get("x-rafter-secret") || "";
  if (!constantTimeEqual(provided, secret)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const uuid = url.searchParams.get("uuid");
  if (!uuid) return json({ error: "missing_param", param: "uuid" }, { status: 400 });

  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });

  return json({
    access_token: config.access_token || null,
    staff_uuid: config.staff_uuid || null,
    email_template: config.email_template || null,
    company_name: config.company_name || null,
    phone: config.phone || null,
    business_email: config.business_email || null,
    operator_email: config.operator_email || null,
    logo_url: config.logo_url || null,
    webhook_url: config.webhook_url || null,
  });
}

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (method === "POST" && path === "/store-token") return handleStoreToken(request, env);
  if (method === "POST" && path === "/render-email") return handleRenderEmail(request, env);
  if (method === "GET" && path === "/client-config") return handleClientConfig(request, url, env);
  if (method === "GET" && path === "/refresh-materials") return handleRefreshMaterials(url, env);
  if (method === "POST" && path === "/copy-r2-photos") return handleCopyR2Photos(request, url, env);
  if (method === "GET" && path === "/health") return json({ ok: true });

  const clientMatch = method === "GET" && /^\/client\/([0-9a-f-]{36})$/i.exec(path);
  if (clientMatch) return handleReadClient(clientMatch[1], env);
  const materialsMatch = method === "GET" && /^\/materials\/([0-9a-f-]{36})$/i.exec(path);
  if (materialsMatch) return handleReadMaterials(materialsMatch[1], env);
  const photosMatch = method === "GET" && /^\/photos\/([0-9a-f-]{36})$/i.exec(path);
  if (photosMatch) return handleListPhotos(photosMatch[1], env);
  if (method === "GET" && path === "/photo") return handleGetPhoto(url, env);
  if (method === "GET" && path === "/sm8-search") return handleSm8Search(url, env);
  if (method === "GET" && path === "/sm8-staff") return handleSm8Staff(url, env);
  const brandMatch = method === "GET" && /^\/brand\/([a-z0-9_.-]+)$/i.exec(path);
  if (brandMatch) return handleBrandAsset(brandMatch[1], env);
  const logoMatch = method === "GET" && /^\/logo\/([0-9a-f-]{36})$/i.exec(path);
  if (logoMatch) return handleClientLogo(logoMatch[1], env);
  const slugMatch = method === "GET" && /^\/resolve-slug\/([a-z0-9-]+)$/i.exec(path);
  if (slugMatch) return handleResolveSlug(slugMatch[1], env);

  return json({ error: "not_found", path }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const response = await route(request, env);
    return withCors(request, response);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};
