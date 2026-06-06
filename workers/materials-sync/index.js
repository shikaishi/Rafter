const SM8_MATERIALS_URL = "https://api.servicem8.com/api_1.0/material.json?$filter=active%20eq%201";
const SM8_COMPANY_SEARCH_URL = "https://api.servicem8.com/api_1.0/company.json";
// https://developer.servicem8.com/docs/authentication
const SM8_TOKEN_URL = "https://go.servicem8.com/oauth/access_token";
const SM8_CLIENT_ID = "781230";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh if expiring within 5 min
const MATERIALS_TTL_SECONDS = 86400;
const CLIENT_KEY_PREFIX = "client:";
const MATERIALS_KEY_PREFIX = "materials:";
const PHOTO_PREFIX = (uuid) => `clients/${uuid}/photos/`;
const SENSITIVE_CLIENT_FIELDS = ["access_token", "refresh_token", "expires_at", "token_updated_at", "webhook_url"];

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

async function hmacSha256(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requireWorkerSecret(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.RAFTER_WORKER_SECRET || token !== env.RAFTER_WORKER_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
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

  try {
    await writeClient(env, uuid, config);
  } catch (e) {
    // KV write failure after SM8 has already rotated the token — re-throw so callers
    // return a 502 rather than silently returning the new in-memory token while KV
    // still holds the old (now-invalidated) refresh_token.
    throw new Error(`kv_write_failed_after_token_refresh: ${e.message}`);
  }
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
  // Accept either MAKE_STORE_TOKEN_SECRET (Make Account Discovery) or RAFTER_WORKER_SECRET
  // (admin-api / Claude Code). Splitting these means rotating the internal worker secret
  // doesn't break Make, and vice versa.
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const provided = m ? m[1] : "";
  const makeSecret = env.MAKE_STORE_TOKEN_SECRET;
  const workerSecret = env.RAFTER_WORKER_SECRET;
  const makeOk = makeSecret && constantTimeEqual(provided, makeSecret);
  const workerOk = workerSecret && constantTimeEqual(provided, workerSecret);
  if (!makeOk && !workerOk) {
    if (!makeSecret && !workerSecret) {
      return json({ error: "server_misconfigured", detail: "MAKE_STORE_TOKEN_SECRET and RAFTER_WORKER_SECRET not set" }, { status: 500 });
    }
    return json({ error: "unauthorized" }, { status: 401 });
  }

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

  const config = (await readClient(env, uuid)) || { uuid };

  config.access_token = access_token;
  if (refresh_token !== undefined) config.refresh_token = refresh_token;
  if (expires_at !== undefined) config.expires_at = expires_at;
  config.token_updated_at = new Date().toISOString();

  await writeClient(env, uuid, config);
  // Keep clerk_org reverse index in sync whenever the record has clerk_org_id set
  if (config.clerk_org_id) {
    await env.RAFTER_CLIENTS.put('clerk_org:' + config.clerk_org_id, uuid).catch(() => {});
  }
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

async function handleGetFormToken(url, env) {
  const uuid = url.searchParams.get("uuid");
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    return json({ error: "invalid_uuid" }, { status: 400 });
  }
  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found" }, { status: 404 });
  if (!env.RAFTER_INTERNAL_SECRET) return json({ error: "server_misconfigured" }, { status: 500 });
  const ts = Math.floor(Date.now() / 1000);
  const data = `${uuid}:${ts}`;
  const sig = await hmacSha256(data, env.RAFTER_INTERNAL_SECRET);
  return json({ token: `${data}:${sig}`, expires_in: 60 });
}

async function verifyFormToken(token, uuid, env) {
  if (!env.RAFTER_INTERNAL_SECRET) return false;
  const parts = token.split(":");
  if (parts.length !== 3) return false;
  const [tokenUuid, tsStr, sig] = parts;
  if (tokenUuid !== uuid) return false;
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts) || Math.floor(Date.now() / 1000) - ts > 60) return false;
  const expected = await hmacSha256(`${tokenUuid}:${tsStr}`, env.RAFTER_INTERNAL_SECRET);
  return sig === expected;
}

async function handleRefreshMaterials(url, env, request) {
  const uuid = url.searchParams.get("uuid");
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    return json({ error: "invalid_uuid" }, { status: 400 });
  }
  // Accept either a worker-secret (operational) or a form token (browser)
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const workerSecretOk = env.RAFTER_WORKER_SECRET && token === env.RAFTER_WORKER_SECRET;
  const formTokenOk = !workerSecretOk && await verifyFormToken(token, uuid, env);
  if (!workerSecretOk && !formTokenOk) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

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

async function handleSm8Staff(url, env, request) {
  const denied = requireWorkerSecret(request, env);
  if (denied) return denied;
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
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    return json({ error: "invalid_uuid" }, { status: 400 });
  }
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
      address: (c.address || [c.address_street, c.address_city, c.address_state, c.address_postcode].filter(Boolean).join(", ")).replace(/\n/g, ", "),
      email: c.email || c.billing_email || "",
      phone: c.mobile_phone || c.phone || "",
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

// ─── RFT-31 Telemetry & Probes ────────────────────────────────────────────────

const MAKE_SCENARIO_IDS = ["5612449", "5537814"];
const MAKE_SCENARIO_NAMES = { "5612449": "Account Discovery", "5537814": "Rafter Form prod" };
const MAKE_BASE_URL = "https://eu1.make.com/api/v2";

// sendTelegramAlert: POST to Telegram Bot API sendMessage.
// Ref: https://core.telegram.org/bots/api#sendmessage
// Token goes in URL path (no Authorization header). 4096-char cap enforced.
// Worker → Telegram only — never routed via SM8 or Make (alert path must not
// depend on what it reports on).
async function sendTelegramAlert(text, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error(JSON.stringify({ event: "telegram_alert_skipped", reason: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" }));
    return;
  }
  const truncated = text.length > 4096 ? text.slice(0, 4093) + "…" : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: truncated }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(JSON.stringify({ event: "telegram_send_failed", status: res.status, body: body.slice(0, 200) }));
    }
  } catch (e) {
    console.error(JSON.stringify({ event: "telegram_send_error", error: e.message }));
  }
}

// writeD1Event: append a row to rafter-events.events.
async function writeD1Event(env, eventType, clientUuid, payload) {
  if (!env.RAFTER_EVENTS) return;
  try {
    await env.RAFTER_EVENTS.prepare(
      "INSERT INTO events (id, client_uuid, event_type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)"
    ).bind(
      crypto.randomUUID(),
      clientUuid || null,
      eventType,
      new Date().toISOString(),
      payload ? JSON.stringify(payload) : null
    ).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "d1_write_failed", eventType, error: e.message }));
  }
}

// ─── Probe 1 (RFT-45): SM8 token health ──────────────────────────────────────
// Iterates all client KV records and calls refreshTokenIfNeeded for each.
// refreshTokenIfNeeded writes refreshed tokens back to KV when a refresh occurs —
// this is intended and safe in cron context: the existing nightly sync already
// does this per client. Probe 1 runs first so tokens are warm before the sync loop.
async function runProbe1(env) {
  const uuids = await listClientUuids(env);
  for (const uuid of uuids) {
    try {
      await refreshTokenIfNeeded(uuid, env);
      await writeD1Event(env, "token_probe_ok", uuid, null);
    } catch (e) {
      console.error(JSON.stringify({ event: "token_probe_failed", uuid, detail: e.message }));
      await writeD1Event(env, "token_probe_failed", uuid, { detail: e.message });
      await sendTelegramAlert(
        `🚨 Rafter SM8 token probe FAILED\nClient: ${uuid}\nError: ${e.message}\nTime: ${new Date().toISOString()}`,
        env
      );
    }
  }
}

// ─── Probe 2 (RFT-47): Make scenario health ───────────────────────────────────
// Checks isPaused, isActive, dlqCount, and last execution status for each watched scenario.
// Refs: https://developers.make.com/api-documentation/api-reference/scenarios
//       https://developers.make.com/api-documentation/api-reference/scenarios/logs
// Auth: "Authorization: Token {token}" — NOT Bearer.
// Logs status is INTEGER: 1=success, 3=error (not a string).
// Limitation: catches deactivated/erroring/dlq-backed-up scenarios. Does NOT detect
// latent breaks such as MAKE_STORE_TOKEN_SECRET drift — that is Probe 3's job.
async function runProbe2(env) {
  const token = env.MAKE_API_TOKEN;
  if (!token) {
    console.error(JSON.stringify({ event: "probe2_skipped", reason: "MAKE_API_TOKEN not set" }));
    await sendTelegramAlert("🚨 Rafter Probe 2 skipped: MAKE_API_TOKEN not set. Set secret and redeploy.", env);
    return;
  }
  const authHeaders = { "Authorization": `Token ${token}` };

  for (const scenarioId of MAKE_SCENARIO_IDS) {
    const name = MAKE_SCENARIO_NAMES[scenarioId];
    const signals = [];

    try {
      const res = await fetch(`${MAKE_BASE_URL}/scenarios/${scenarioId}`, { headers: authHeaders });
      if (!res.ok) {
        signals.push(`status_check_failed:${res.status}`);
        console.error(JSON.stringify({ event: "probe2_scenario_http_error", scenarioId, status: res.status }));
      } else {
        const data = await res.json();
        const s = data.scenario || data;
        if (s.isPaused) signals.push("isPaused=true");
        if (s.isActive === false) signals.push("isActive=false");
        if (typeof s.dlqCount === "number" && s.dlqCount > 0) signals.push(`dlqCount=${s.dlqCount}`);
      }
    } catch (e) {
      signals.push("status_fetch_error");
      console.error(JSON.stringify({ event: "probe2_scenario_fetch_error", scenarioId, error: e.message }));
    }

    try {
      const res = await fetch(`${MAKE_BASE_URL}/scenarios/${scenarioId}/logs?pg[limit]=1`, { headers: authHeaders });
      if (!res.ok) {
        signals.push(`logs_check_failed:${res.status}`);
      } else {
        const data = await res.json();
        const logs = Array.isArray(data) ? data : (data.scenarioLogs || data.logs || []);
        if (logs.length > 0 && logs[0].status === 3) signals.push("last_execution_error");
      }
    } catch (e) {
      signals.push("logs_fetch_error");
      console.error(JSON.stringify({ event: "probe2_logs_fetch_error", scenarioId, error: e.message }));
    }

    if (signals.length > 0) {
      await writeD1Event(env, "make_scenario_unhealthy", null, { scenario_id: scenarioId, name, signals });
      await sendTelegramAlert(
        `🚨 Rafter Make probe: scenario unhealthy\nScenario: ${name} (${scenarioId})\nSignals: ${signals.join(", ")}\nTime: ${new Date().toISOString()}`,
        env
      );
    }
  }
}

// ─── Probe 3 (RFT-48): recovery-path component health ────────────────────────
// DESIGN from RFT-44: full end-to-end exercise of Account Discovery is UNSAFE on
// a schedule — SM8 uses rotating refresh tokens; a KV write failure mid-exchange
// would lock out the trial instance. Component-checking is used instead.
//
// Checks:
//   a. MAKE_STORE_TOKEN_SECRET and RAFTER_WORKER_SECRET are present in env —
//      confirms the auth path for /store-token is intact without any HTTP call.
//   b. Account Discovery (5612449) last SUCCESS log entry is within 30 days —
//      lagging indicator for MAKE_STORE_TOKEN_SECRET drift. If Account Discovery
//      hasn't succeeded recently, the most likely cause is a secret mismatch.
//
// Detection only — never auto-mutates tokens or secrets.
// Admin API is the only privileged write path (CLAUDE.md constraint).
async function runProbe3(env) {
  const signals = [];

  if (!env.MAKE_STORE_TOKEN_SECRET) signals.push("MAKE_STORE_TOKEN_SECRET_missing");
  if (!env.RAFTER_WORKER_SECRET) signals.push("RAFTER_WORKER_SECRET_missing");

  const token = env.MAKE_API_TOKEN;
  if (token) {
    try {
      const res = await fetch(`${MAKE_BASE_URL}/scenarios/5612449/logs?pg[limit]=20`, {
        headers: { "Authorization": `Token ${token}` },
      });
      if (!res.ok) {
        signals.push(`account_discovery_logs_failed:${res.status}`);
      } else {
        const data = await res.json();
        const logs = Array.isArray(data) ? data : (data.scenarioLogs || data.logs || []);
        const lastSuccess = logs.find((l) => l.status === 1);
        if (!lastSuccess) {
          signals.push("account_discovery_no_recent_success");
        } else {
          const ageDays = (Date.now() - new Date(lastSuccess.timestamp).getTime()) / 86400000;
          if (ageDays > 30) signals.push(`account_discovery_last_success_${Math.floor(ageDays)}d_ago`);
        }
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "probe3_logs_error", error: e.message }));
    }
  }

  if (signals.length > 0) {
    await writeD1Event(env, "recovery_probe_failed", null, { signals });
    await sendTelegramAlert(
      `🚨 Rafter recovery probe: component unhealthy\nSignals: ${signals.join(", ")}\nTime: ${new Date().toISOString()}`,
      env
    );
  }
}

// ─── RFT-49: external heartbeat (dead-man's switch) ──────────────────────────
// Pings HEARTBEAT_URL at the end of each cron run. An external monitor (off-Cloudflare)
// alerts Will if the expected daily ping does NOT arrive — catches the probe Worker
// itself failing to run, which in-Worker alerting cannot detect.
//
// SETUP (one-time, Will):
//   1. Create a check at https://healthchecks.io (free tier: 20 checks, 365-day log).
//      Set period = 1 day, grace period = 2 hours.
//   2. Copy the ping URL (format: https://hc-ping.com/{uuid}).
//   3. npx wrangler secret put HEARTBEAT_URL --name rafter-materials-sync
// Ref: https://healthchecks.io/docs/http_api/
async function pingHeartbeat(env) {
  const url = env.HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(url, { method: "GET" });
  } catch (e) {
    console.error(JSON.stringify({ event: "heartbeat_ping_failed", error: e.message }));
  }
}

// handleSendTestAlert: RFT-46 deploy verification endpoint.
// Sends one test message to confirm Telegram secrets are wired correctly.
// Requires RAFTER_WORKER_SECRET bearer token.
async function handleSendTestAlert(request, env) {
  const denied = bearerCheck(request, env);
  if (denied) return denied;
  await sendTelegramAlert(`🔔 Rafter test alert — Telegram channel confirmed working.\nTime: ${new Date().toISOString()}`, env);
  return json({ ok: true, sent_at: new Date().toISOString() });
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

  // INVARIANT: any handler that returns or uses access_token must call
  // refreshTokenIfNeeded first. /client-config is called by Make at the top
  // of every form submission and supplies the Bearer token for every
  // downstream SM8 call — if it returned a stale token, the entire scenario
  // would fail with SM8 401 (the original BUG-23).
  try {
    await refreshTokenIfNeeded(uuid, env);
  } catch (e) {
    return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 });
  }

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
  if (method === "GET" && path === "/refresh-materials") return handleRefreshMaterials(url, env, request);
  if (method === "GET" && path === "/get-form-token") return handleGetFormToken(url, env);
  if (method === "POST" && path === "/copy-r2-photos") return handleCopyR2Photos(request, url, env);
  if (method === "GET" && path === "/health") return json({ ok: true });
  if (method === "POST" && path === "/send-test-alert") return handleSendTestAlert(request, env);

  const clientMatch = method === "GET" && /^\/client\/([0-9a-f-]{36})$/i.exec(path);
  if (clientMatch) return handleReadClient(clientMatch[1], env);
  const materialsMatch = method === "GET" && /^\/materials\/([0-9a-f-]{36})$/i.exec(path);
  if (materialsMatch) return handleReadMaterials(materialsMatch[1], env);
  const photosMatch = method === "GET" && /^\/photos\/([0-9a-f-]{36})$/i.exec(path);
  if (photosMatch) return handleListPhotos(photosMatch[1], env);
  if (method === "GET" && path === "/photo") return handleGetPhoto(url, env);
  if (method === "GET" && path === "/sm8-search") return handleSm8Search(url, env);
  if (method === "GET" && path === "/sm8-staff") return handleSm8Staff(url, env, request);
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
    ctx.waitUntil((async () => {
      try { await runProbe1(env); } catch (e) { console.error(JSON.stringify({ event: "probe1_uncaught", error: e.message })); }
      try { await runScheduledSync(env); } catch (e) { console.error(JSON.stringify({ event: "sync_uncaught", error: e.message })); }
      try { await runProbe2(env); } catch (e) { console.error(JSON.stringify({ event: "probe2_uncaught", error: e.message })); }
      try { await runProbe3(env); } catch (e) { console.error(JSON.stringify({ event: "probe3_uncaught", error: e.message })); }
      await pingHeartbeat(env);
    })());
  },
};
