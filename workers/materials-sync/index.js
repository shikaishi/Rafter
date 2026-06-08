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
const SENSITIVE_CLIENT_FIELDS = ["access_token", "refresh_token", "expires_at", "token_updated_at", "webhook_url", "bank_details"];
// RFT-93: SM8 material.json fields exposed via /materials/{uuid}. cost is the
// tenant's wholesale buy-price (markup leak); quantity_in_stock is inventory
// state; tax_rate_uuid is an internal SM8 ref the form never consumes.
// Conservative scope — leaves barcode/edit_date/internal-flags untouched.
const SENSITIVE_MATERIAL_FIELDS = ["cost", "quantity_in_stock", "tax_rate_uuid"];

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

function sanitizeMaterials(data) {
  if (!Array.isArray(data)) return data;
  return data.map((item) => {
    if (!item || typeof item !== "object") return item;
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      if (!SENSITIVE_MATERIAL_FIELDS.includes(k)) out[k] = v;
    }
    return out;
  });
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

  const { uuid, access_token, refresh_token, expires_at, connected_by_user_id } = body || {};
  if (!uuid || typeof uuid !== "string") {
    return json({ error: "missing_field", field: "uuid" }, { status: 400 });
  }
  if (!access_token || typeof access_token !== "string") {
    return json({ error: "missing_field", field: "access_token" }, { status: 400 });
  }

  const config = (await readClient(env, uuid)) || { uuid };

  // RFT-70 Option C: track whether this is first-establish vs takeover, so admin-api
  // can log accordingly. Decided on KV state BEFORE we overwrite the token fields.
  const wasConnected = !!config.access_token;
  const previousConnectedBy = config.connected_by_user_id || null;
  const isTakeover = wasConnected
    && connected_by_user_id
    && previousConnectedBy
    && previousConnectedBy !== connected_by_user_id;

  config.access_token = access_token;
  if (refresh_token !== undefined) config.refresh_token = refresh_token;
  if (expires_at !== undefined) config.expires_at = expires_at;
  config.token_updated_at = new Date().toISOString();

  // RFT-70 Option C D2: record who established the connection AND when, on EVERY
  // establish (not only first). Optional in the body so the system-driven refresh
  // path that doesn't go through this endpoint, and legacy Make callers that
  // don't know about the field, both keep working.
  if (connected_by_user_id !== undefined) {
    config.connected_by_user_id = connected_by_user_id;
    config.connected_at = config.token_updated_at;
  }

  await writeClient(env, uuid, config);
  // Keep clerk_org reverse index in sync whenever the record has clerk_org_id set
  if (config.clerk_org_id) {
    await env.RAFTER_CLIENTS.put('clerk_org:' + config.clerk_org_id, uuid).catch(() => {});
  }
  return json({
    ok: true,
    uuid,
    token_updated_at: config.token_updated_at,
    was_connected: wasConnected,
    is_takeover: !!isTakeover,
    previous_connected_by_user_id: previousConnectedBy,
  });
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

async function handleGetFormToken(request, url, env) {
  // RFT-95: per-IP rate limit before any work — cheapest reject path.
  const rl = await rateLimitOrInternal(request, env, env.RATE_TOKEN_MINT);
  if (rl) return rl;
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

async function handleReadClient(request, uuid, env) {
  const a = await requireFormJWT(request, env, { target_uuid: uuid });
  if (a.error) return a.error;
  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });
  const safe = sanitizeClient(config);
  return json({ ok: true, uuid, client: safe });
}

async function handleReadMaterials(request, uuid, env) {
  const a = await requireFormJWT(request, env, { target_uuid: uuid });
  if (a.error) return a.error;
  const raw = await env.RAFTER_CLIENTS.get(MATERIALS_KEY_PREFIX + uuid);
  if (!raw) return json({ error: "materials_not_cached", uuid, hint: "call /refresh-materials first" }, { status: 404 });
  let data;
  try { data = JSON.parse(raw); }
  catch { return json({ error: "materials_corrupt", uuid }, { status: 500 }); }
  return json({ ok: true, uuid, materials: sanitizeMaterials(data) });
}

async function handleListPhotos(request, uuid, env) {
  const a = await requireFormJWT(request, env, { target_uuid: uuid });
  if (a.error) return a.error;
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

async function handleGetPhoto(request, url, env) {
  if (!env.RAFTER_ASSETS) return new Response("r2_not_bound", { status: 500 });
  const uuid = url.searchParams.get("uuid");
  const key = url.searchParams.get("key");
  if (!uuid || !key) return new Response("missing_params", { status: 400 });
  const a = await requireFormJWT(request, env, { target_uuid: uuid });
  if (a.error) return a.error;
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

async function handleResolveSlug(request, slug, env) {
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) {
    return json({ error: "invalid_slug" }, { status: 400 });
  }
  const a = await requireFormJWT(request, env, { target_slug: slug });
  if (a.error) return a.error;
  return json({ ok: true, slug, uuid: a.uuid });
}

async function handleSm8Search(request, url, env) {
  const uuid = url.searchParams.get("uuid");
  const q = (url.searchParams.get("q") || "").trim();
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    return json({ error: "invalid_uuid" }, { status: 400 });
  }
  const a = await requireFormJWT(request, env, { target_uuid: uuid });
  if (a.error) return a.error;
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

// 5612449 ("Account Discovery") + 5612520 ("Data Retrieval") deactivated 2026-06-07
// after Path 2 (RFT-69) removed Make from the OAuth path. Only the prod Rafter
// Form scenario remains in Probe 2's watched list.
const MAKE_SCENARIO_IDS = ["5537814"];
const MAKE_SCENARIO_NAMES = { "5537814": "Rafter Form prod" };
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

// ─── RFT-32 / RFT-37: rafter-quotes draft persistence ────────────────────────
// Bounded-stateful: SM8 stays system-of-record for issued quotes; rafter-quotes
// D1 persists buildPayload() JSON verbatim so quotes can be rehydrated into the
// form and amended onto the same SM8 job (Path B versioned amend).
//
// AUTH (two gates, same write):
//   • /store-draft, /draft/{ref}, /drafts — x-rafter-secret (RAFTER_INTERNAL_SECRET),
//     mirrors /client-config and /render-email. Internal worker-to-worker calls
//     and rafter form's privileged ops use this. The form reaches these via the
//     same internal-secret path that gates /render-email.
//   • /store-quote-link — Bearer MAKE_STORE_TOKEN_SECRET, matches /store-token's
//     Make→worker pattern. This is the Make callback after SM8 job-create — Make
//     is the only caller that knows the new SM8 job UUID, so it's the only path
//     for the initial post-submit write (Path A).
//
// DELIBERATE PROPERTY — DO NOT "FIX" INTO A BLOCKING WRITE:
// /store-draft is best-effort by design (RFT-32 RESUME BRIEF, 2026-06-06). The
// CALLER must wrap the call in try/catch and continue on failure. A dropped
// draft costs a future edit convenience; a blocked submit costs a live quote.
// The submit path was just hardened (RFT-58/RFT-69) — never put a synchronous
// failure mode in front of it. Consequence: rafter-quotes is best-effort, not
// guaranteed-complete; a quote can reach the customer without being stored,
// finder won't show it, self-corrects on next edit re-submit.
//
// LOAD-BEARING CONSTRAINT — sm8_job_uuid (RFT-35): SM8 has NO job-search
// fallback. Stored sm8_job_uuid is the SOLE linkage back to the SM8 job for
// amendment. If it's null or wrong, amendment is impossible. /store-draft
// validates the UUID is present + well-formed before writing; if absent, it
// rejects with 400 and logs loudly — that condition means the upstream SM8
// job-create leg failed, which is a real problem worth surfacing rather than
// hiding behind a soft-null row.

const QUOTE_REF_RE = /^Q-\d{8}-\d{4}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireInternalSecret(request, env) {
  if (!env.RAFTER_INTERNAL_SECRET) {
    return json({ error: "server_misconfigured", detail: "RAFTER_INTERNAL_SECRET not set" }, { status: 500 });
  }
  const provided = request.headers.get("x-rafter-secret") || "";
  if (!constantTimeEqual(provided, env.RAFTER_INTERNAL_SECRET)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// /store-quote-link is hit by Make (Rafter Form prod scenario 5537814) after
// SM8 job-create. Make uses Bearer-token auth (see /store-token for the
// established pattern). We reuse MAKE_STORE_TOKEN_SECRET here so Will doesn't
// have to provision a second Make secret for what is the same trust
// boundary (Make UI → materials-sync). The name is narrower than the role;
// if Will wants per-scenario rotation later, swap to a per-endpoint secret —
// the auth gate is a one-line change.
function requireMakeSecret(request, env) {
  const expected = env.MAKE_STORE_TOKEN_SECRET;
  if (!expected) {
    return json({ error: "server_misconfigured", detail: "MAKE_STORE_TOKEN_SECRET not set" }, { status: 500 });
  }
  const header = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !constantTimeEqual(m[1], expected)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

// Dual-gate auth for read/finder/amend endpoints called from the rafter form:
//   • x-rafter-secret (RAFTER_INTERNAL_SECRET) — internal worker callers,
//     unscoped (no tenant restriction; trusted caller).
//   • Bearer <form-HMAC-token> — issued by /get-form-token, valid 60s, embeds
//     a client_uuid. Returns scopedToUuid so handlers can enforce that the
//     requested row's client_uuid matches. Without scoping, a form token for
//     tenant A could read/edit tenant B's quotes.
// RFT-95: per-IP rate limit gate. Trusted internal callers (admin-api W2W,
// internal scripts using x-rafter-secret) bypass — same trust boundary as
// requireFormOrInternal. Public callers are keyed by cf-connecting-ip.
// Fail-open if binding missing (defence-in-depth supplementing the RFT-87
// auth gate, not the primary security control).
async function rateLimitOrInternal(request, env, binding) {
  if (!binding) return null;
  const internal = request.headers.get("x-rafter-secret") || "";
  if (env.RAFTER_INTERNAL_SECRET && constantTimeEqual(internal, env.RAFTER_INTERNAL_SECRET)) {
    return null;
  }
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const { success } = await binding.limit({ key: ip });
  if (success) return null;
  return new Response(JSON.stringify({ error: "rate_limited", retry_after: 60 }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "60" },
  });
}

// RFT-87 scope (a) — JWT-or-internal verifier for form-callable endpoints.
// The form sends its Clerk JWT in Authorization; we forward that to admin-api's
// /form/verify-tenant (the single source of truth for verifyToken + cross-tenant
// uuid match). Trusted internal callers (Make, cron, admin-api W2W) bypass via
// x-rafter-secret matching RAFTER_INTERNAL_SECRET — same trust boundary as the
// legacy requireFormOrInternal.
//
// Pass exactly one of target_uuid OR target_slug. The verifier:
//   - On internal-secret bypass: resolves slug → uuid for the handler's
//     convenience, returns { ok, uuid, role: "internal" }.
//   - On form JWT path: proxies to admin-api, which 403s if the JWT's org
//     does not own the target. Returns { ok, uuid, org_id, role } on match.
// On any failure returns { error: Response } for the caller to short-circuit.
async function requireFormJWT(request, env, { target_uuid, target_slug }) {
  // Internal-secret bypass — Make / cron / admin-api are trusted, unscoped.
  if (env.RAFTER_INTERNAL_SECRET) {
    const internal = request.headers.get("x-rafter-secret") || "";
    if (internal && constantTimeEqual(internal, env.RAFTER_INTERNAL_SECRET)) {
      let resolved = target_uuid;
      if (!resolved && target_slug) {
        resolved = await env.RAFTER_CLIENTS.get(`slug:${target_slug}`).catch(() => null);
        if (!resolved) return { error: json({ error: "slug_not_found", slug: target_slug }, { status: 404 }) };
      }
      return { ok: true, uuid: resolved, role: "internal" };
    }
  }

  if (!env.ADMIN_API) {
    return { error: json({ error: "server_misconfigured", detail: "ADMIN_API binding not set" }, { status: 500 }) };
  }
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return { error: json({ error: "unauthorized", detail: "missing_bearer" }, { status: 401 }) };
  }

  const verifyBody = target_uuid ? { target_uuid } : { target_slug };
  const res = await env.ADMIN_API.fetch("https://internal/form/verify-tenant", {
    method: "POST",
    headers: { "Authorization": auth, "Content-Type": "application/json" },
    body: JSON.stringify(verifyBody),
  });

  if (res.status === 401) return { error: json({ error: "unauthorized" }, { status: 401 }) };
  if (res.status === 403) return { error: json({ error: "cross_tenant_forbidden" }, { status: 403 }) };
  if (res.status === 404) return { error: json({ error: "not_found" }, { status: 404 }) };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: json({ error: "verify_failed", status: res.status, detail: detail.slice(0, 200) }, { status: 502 }) };
  }
  let data;
  try { data = await res.json(); }
  catch { return { error: json({ error: "verify_invalid_response" }, { status: 502 }) }; }
  return { ok: true, uuid: data.uuid, org_id: data.org_id, role: data.role };
}

async function requireFormOrInternal(request, env) {
  if (!env.RAFTER_INTERNAL_SECRET) {
    return { error: json({ error: "server_misconfigured", detail: "RAFTER_INTERNAL_SECRET not set" }, { status: 500 }) };
  }
  const internalProvided = request.headers.get("x-rafter-secret") || "";
  if (internalProvided && constantTimeEqual(internalProvided, env.RAFTER_INTERNAL_SECRET)) {
    return { ok: true, scopedToUuid: null };
  }
  const auth = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) {
    const token = m[1];
    const parts = token.split(":");
    if (parts.length === 3) {
      const [tokenUuid, tsStr, sig] = parts;
      const ts = parseInt(tsStr, 10);
      if (!isNaN(ts) && Math.floor(Date.now() / 1000) - ts <= 60 && UUID_RE.test(tokenUuid)) {
        const expected = await hmacSha256(`${tokenUuid}:${tsStr}`, env.RAFTER_INTERNAL_SECRET);
        if (sig === expected) {
          return { ok: true, scopedToUuid: tokenUuid };
        }
      }
    }
  }
  return { error: json({ error: "unauthorized" }, { status: 401 }) };
}

// Parse + validate the rafter-quotes row fields from a request body.
// Returns { error: Response } on validation failure, or { fields } on success.
// All three writers (/store-draft, /store-quote-link, amend op) share this.
//
// PAYLOAD STRING TOLERANCE: Make's HTTP module body templates can pass `payload`
// as either an inline JSON object (`{{34}}` referencing the ParseJSON output)
// or a quoted string (`"{{1.payload}}"` — the raw webhook form-field). The
// former is the cleaner Make pattern but depends on Make correctly serialising
// the parsed collection inline. To make /store-quote-link robust to either,
// accept payload as either object or string, parsing the string in the latter
// case. /store-draft is internal so it will always send objects; this branch
// is essentially dead for the internal path but harmless.
function validateQuoteFields(body, opts = {}) {
  const { allowParentRef = true } = opts;
  if (!body || typeof body !== "object") {
    return { error: json({ error: "invalid_body" }, { status: 400 }) };
  }
  let { quote_ref, client_uuid, sm8_job_uuid, payload } = body;
  // Base64-encoded payload from Make — Make's jsonString body builder can't
  // cleanly serialise a nested JSON object without quote/brace ambiguity, so
  // we accept a `payload_b64` field that's base64(JSON-string) and decode here.
  if (!payload && typeof body.payload_b64 === "string") {
    try {
      const decoded = atob(body.payload_b64);
      payload = JSON.parse(decoded);
    } catch (e) {
      return { error: json({ error: "payload_b64_decode_failed", detail: e.message }, { status: 400 }) };
    }
  }
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); }
    catch { return { error: json({ error: "payload_not_json", detail: "payload was a string but did not parse as JSON" }, { status: 400 }) }; }
  }
  const version = Number.isInteger(body.version) && body.version >= 1 ? body.version : 1;
  const parent_ref = body.parent_ref || null;
  const status = body.status || "submitted";

  if (!quote_ref || !QUOTE_REF_RE.test(quote_ref)) {
    return { error: json({ error: "invalid_quote_ref", hint: "Q-YYYYMMDD-HHMM" }, { status: 400 }) };
  }
  if (!client_uuid || !UUID_RE.test(client_uuid)) {
    return { error: json({ error: "invalid_client_uuid" }, { status: 400 }) };
  }
  if (!sm8_job_uuid || !UUID_RE.test(sm8_job_uuid)) {
    // Loud log: absent sm8_job_uuid means the upstream SM8 job-create leg
    // failed. Surface it — never write a null/garbage UUID (RFT-35).
    console.error(JSON.stringify({
      event: "quote_write_missing_sm8_job_uuid",
      quote_ref,
      client_uuid,
      provided: sm8_job_uuid || null,
    }));
    return { error: json({ error: "missing_or_invalid_sm8_job_uuid", detail: "SM8 job-create likely failed upstream" }, { status: 400 }) };
  }
  if (allowParentRef && parent_ref !== null && !QUOTE_REF_RE.test(parent_ref)) {
    return { error: json({ error: "invalid_parent_ref" }, { status: 400 }) };
  }
  if (!payload || typeof payload !== "object") {
    return { error: json({ error: "missing_field", field: "payload" }, { status: 400 }) };
  }

  return { fields: { quote_ref, client_uuid, sm8_job_uuid, version, parent_ref, status, payload } };
}

// Write (or upsert) a rafter-quotes row. INSERT OR REPLACE on quote_ref so
// callers can retry safely. Returns { ok: true, updated_at } or { error: Response }.
async function writeQuoteRow(env, fields) {
  if (!env.RAFTER_QUOTES) {
    return { error: json({ error: "server_misconfigured", detail: "RAFTER_QUOTES binding not set" }, { status: 500 }) };
  }
  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(fields.payload);
  try {
    await env.RAFTER_QUOTES.prepare(
      `INSERT INTO quotes (quote_ref, client_uuid, sm8_job_uuid, version, parent_ref, payload, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(quote_ref) DO UPDATE SET
         client_uuid=excluded.client_uuid,
         sm8_job_uuid=excluded.sm8_job_uuid,
         version=excluded.version,
         parent_ref=excluded.parent_ref,
         payload=excluded.payload,
         status=excluded.status,
         updated_at=excluded.updated_at`
    ).bind(
      fields.quote_ref, fields.client_uuid, fields.sm8_job_uuid, fields.version,
      fields.parent_ref, payloadJson, fields.status, now, now
    ).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "quote_write_d1_failed", quote_ref: fields.quote_ref, error: e.message }));
    return { error: json({ error: "d1_write_failed", detail: e.message }, { status: 502 }) };
  }
  return { ok: true, updated_at: now };
}

async function handleStoreDraft(request, env) {
  const denied = requireInternalSecret(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, { status: 400 }); }

  const v = validateQuoteFields(body);
  if (v.error) return v.error;

  const w = await writeQuoteRow(env, v.fields);
  if (w.error) return w.error;

  return json({ ok: true, quote_ref: v.fields.quote_ref, version: v.fields.version, status: v.fields.status, updated_at: w.updated_at });
}

// /store-quote-link — Make callback after SM8 job-create. Same write logic as
// /store-draft, different auth gate (Make Bearer token, not x-rafter-secret).
// Path A architecture (RFT-32 RESUME BRIEF, 2026-06-06): Make has the original
// payload (PDF worker forwarded it via the webhook), Make captures
// x-record-uuid from SM8 job-create as sm8_job_uuid, then POSTs the full
// {quote_ref, client_uuid, sm8_job_uuid, payload} back here. This keeps the
// strict "sm8_job_uuid present by construction" invariant — by the time this
// endpoint fires, the SM8 job exists. Single write per submit. No orphan rows.
async function handleStoreQuoteLink(request, env) {
  const denied = requireMakeSecret(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, { status: 400 }); }

  const v = validateQuoteFields(body);
  if (v.error) return v.error;

  const w = await writeQuoteRow(env, v.fields);
  if (w.error) return w.error;

  console.log(JSON.stringify({
    event: "store_quote_link_ok",
    quote_ref: v.fields.quote_ref,
    sm8_job_uuid: v.fields.sm8_job_uuid,
    version: v.fields.version,
  }));

  return json({ ok: true, quote_ref: v.fields.quote_ref, version: v.fields.version, status: v.fields.status, updated_at: w.updated_at });
}

function summariseDraftRow(row) {
  let p = {};
  try { p = JSON.parse(row.payload || "{}"); } catch { /* corrupt payload — surface as empty summary */ }
  return {
    quote_ref: row.quote_ref,
    client_uuid: row.client_uuid,
    sm8_job_uuid: row.sm8_job_uuid,
    version: row.version,
    parent_ref: row.parent_ref,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Extracted from payload for finder display; safe defaults if payload corrupt.
    client_name: p.client_name || "",
    site_address: p.site_address || "",
    total: typeof p.total === "number" ? p.total : null,
    proposal_type: p.proposal_type || "",
    proposal_date: p.proposal_date || "",
  };
}

async function handleGetDraft(request, quote_ref, env) {
  const a = await requireFormOrInternal(request, env);
  if (a.error) return a.error;
  if (!env.RAFTER_QUOTES) {
    return json({ error: "server_misconfigured", detail: "RAFTER_QUOTES binding not set" }, { status: 500 });
  }
  if (!QUOTE_REF_RE.test(quote_ref)) {
    return json({ error: "invalid_quote_ref" }, { status: 400 });
  }
  let row;
  try {
    row = await env.RAFTER_QUOTES.prepare(
      "SELECT * FROM quotes WHERE quote_ref = ?"
    ).bind(quote_ref).first();
  } catch (e) {
    return json({ error: "d1_read_failed", detail: e.message }, { status: 502 });
  }
  if (!row) return json({ error: "draft_not_found", quote_ref }, { status: 404 });
  // Form-token scoping — return 404 (not 403) to avoid leaking row existence
  // across tenants. 403 would confirm the quote_ref exists for another tenant.
  if (a.scopedToUuid && row.client_uuid !== a.scopedToUuid) {
    return json({ error: "draft_not_found", quote_ref }, { status: 404 });
  }

  let parsed;
  try { parsed = JSON.parse(row.payload); }
  catch { return json({ error: "payload_corrupt", quote_ref }, { status: 500 }); }

  return json({
    ok: true,
    quote_ref: row.quote_ref,
    client_uuid: row.client_uuid,
    sm8_job_uuid: row.sm8_job_uuid,
    version: row.version,
    parent_ref: row.parent_ref,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: parsed,
  });
}

async function handleListDrafts(request, url, env) {
  const a = await requireFormOrInternal(request, env);
  if (a.error) return a.error;
  if (!env.RAFTER_QUOTES) {
    return json({ error: "server_misconfigured", detail: "RAFTER_QUOTES binding not set" }, { status: 500 });
  }

  // Under form-token auth, force the filter to the token's embedded uuid —
  // any caller-supplied client_uuid is ignored. Under x-rafter-secret (internal),
  // honour the query param.
  const queriedClientUuid = url.searchParams.get("client_uuid");
  const client_uuid = a.scopedToUuid || queriedClientUuid;
  const q = (url.searchParams.get("q") || "").trim();
  const sm8_job_uuid = url.searchParams.get("sm8_job_uuid");
  const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Math.max(1, Math.min(50, isNaN(limitParam) ? 20 : limitParam));

  if (!client_uuid || !UUID_RE.test(client_uuid)) {
    return json({ error: "invalid_client_uuid" }, { status: 400 });
  }
  if (sm8_job_uuid && !UUID_RE.test(sm8_job_uuid)) {
    return json({ error: "invalid_sm8_job_uuid" }, { status: 400 });
  }

  // Fetch a working set, then filter q in-worker. For small per-tenant
  // datasets (a tradie produces tens to low-hundreds of quotes/year) this is
  // faster and simpler than JSON1 + a per-field index. Reconsider if a single
  // tenant exceeds a few thousand rows.
  const workingLimit = q ? Math.min(200, limit * 10) : limit;

  let rows;
  try {
    let stmt;
    if (sm8_job_uuid) {
      stmt = env.RAFTER_QUOTES.prepare(
        "SELECT * FROM quotes WHERE client_uuid = ? AND sm8_job_uuid = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(client_uuid, sm8_job_uuid, workingLimit);
    } else {
      stmt = env.RAFTER_QUOTES.prepare(
        "SELECT * FROM quotes WHERE client_uuid = ? ORDER BY updated_at DESC LIMIT ?"
      ).bind(client_uuid, workingLimit);
    }
    const res = await stmt.all();
    rows = res.results || [];
  } catch (e) {
    return json({ error: "d1_read_failed", detail: e.message }, { status: 502 });
  }

  const summaries = rows.map(summariseDraftRow);

  // RFT-85: exclude rows whose SM8 job is deleted (active=0). SM8 does NOT
  // block writes to dead jobs, so the finder must verify liveness directly.
  // Single batched OData GET — tradie working set is bounded. If the SM8 read
  // fails, degrade to empty result rather than surface potentially-dead rows
  // (data-integrity over availability).
  let liveSummaries = summaries;
  const uniqueJobUuids = [...new Set(summaries.map((s) => s.sm8_job_uuid).filter(Boolean))];
  if (uniqueJobUuids.length) {
    let accessToken;
    try { accessToken = await refreshTokenIfNeeded(client_uuid, env); }
    catch (e) { return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 }); }
    const liveSet = await sm8FetchActiveSet(accessToken, uniqueJobUuids);
    if (liveSet === null) {
      return json({ ok: true, count: 0, results: [], note: "sm8_liveness_check_failed" });
    }
    liveSummaries = summaries.filter((s) => liveSet.has(s.sm8_job_uuid));
  }

  let results = liveSummaries;
  if (q) {
    const ql = q.toLowerCase();
    results = liveSummaries.filter((r) =>
      (r.quote_ref || "").toLowerCase().includes(ql)
      || (r.client_name || "").toLowerCase().includes(ql)
      || (r.site_address || "").toLowerCase().includes(ql)
    ).slice(0, limit);
  } else {
    results = liveSummaries.slice(0, limit);
  }

  return json({ ok: true, count: results.length, results });
}

// ─── RFT-39: amend op (versioned re-send onto existing SM8 job) ──────────────
// Path B versioned amend (RFT-32). Bypasses Make entirely — Make is only needed
// for the original submit (job-create + first attach). For amend we already
// know the SM8 job UUID (from the parent rafter-quotes row), so the worker calls
// SM8 directly: attach new PDF + append delimited job_description block.
//
// SCOPES (CRITICAL — verify trial re-auth before testing):
//   • create_jobs (have, RFT-26)         — not used here, listed for completeness
//   • manage_jobs (have)                 — POST /job/{uuid}.json job_description update
//   • publish_job_attachments (have)     — POST /Attachment.json + /Attachment/{uuid}.file
//   • read_jobs (have)                   — GET /job/{uuid}.json before append
//   • read_attachments (added 2026-06-06 to setup.html) — required for finder attachment view (RFT-38)
//
// If the trial token doesn't have manage_jobs + publish_job_attachments, SM8
// returns 403 at the attach step. Re-auth via setup.html (Flow D — human, ~1 min).
//
// Format of the appended block mirrors PDF worker's buildJobDescription delimiter:
//   --- RAFTER:Q-YYYYMMDD-HHMM:START ---
//   [structured block]
//   --- RAFTER:Q-YYYYMMDD-HHMM:END ---
// Parseable by quote_ref, operator-legible. Append-only (constraint #4, Rafter
// rule — SM8 itself allows overwrite per RFT-34, but Rafter never does).

const SM8_BASE = "https://api.servicem8.com/api_1.0";

function fmtAUD(n) {
  if (typeof n !== "number") return "";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

// Mirror of PDF worker's buildJobDescription — kept in sync by structure, not by
// import (no shared lib). Operator only sees this in SM8 job_description so the
// shape must match the format already used by submit, otherwise version blocks
// look inconsistent.
function buildJobDescriptionBlock(payload, labels) {
  const ref = payload.quote_ref || "";
  const lines = [
    `--- RAFTER:${ref}:START ---`,
    `Ref:  ${ref}`,
    `Date: ${payload.proposal_date || ""}`,
    `Type: ${(labels && labels[payload.proposal_type]) || payload.proposal_type || ""}`,
    `Site: ${payload.site_address || ""}`,
    "",
  ];
  for (const s of (payload.sections || [])) {
    const heading = s.heading || (s.items?.[0]?.name) || "";
    const price = s.items?.[0]?.price != null ? fmtAUD(s.items[0].price) : "";
    lines.push(`${heading}${price ? " — " + price : ""}`);
    const scope = s.items?.[0]?.scope || "";
    if (scope) lines.push(scope);
    lines.push("");
  }
  if (payload.total != null) lines.push(`Total (inc. GST): ${fmtAUD(payload.total)}`);
  if (payload.notes) { lines.push(""); lines.push(`Notes: ${payload.notes}`); }
  lines.push(`--- RAFTER:${ref}:END ---`);
  return lines.join("\n");
}

function buildProposalTypeLabels(proposalTypes) {
  const labels = {};
  if (!Array.isArray(proposalTypes)) return labels;
  for (const item of proposalTypes) {
    if (item && typeof item === "object" && item.code) labels[item.code] = item.label || item.code;
  }
  return labels;
}

async function fetchAmendPdf(env, payload) {
  if (!env.PDF_WORKER) {
    return { ok: false, status: 500, error: { error: "pdf_worker_binding_missing", detail: "Service binding PDF_WORKER not configured — redeploy materials-sync" } };
  }
  // Service binding URL hostname is ignored by Cloudflare; the binding routes
  // directly to the bound worker. mode=preview returns binary, no auth required.
  const req = new Request("https://rafter-pdf.internal/generate?mode=preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await env.PDF_WORKER.fetch(req);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: 502, error: { error: "pdf_generate_failed", status: res.status, detail: detail.slice(0, 500) } };
  }
  const bytes = await res.arrayBuffer();
  // Filename is canonical on PDF worker (buildPdfFilename) — read it back via
  // Content-Disposition so SM8 attachment_name matches the customer-facing
  // filename verbatim. If header malformed, fall back to a quote_ref shape.
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="([^"]+)"/);
  const filename = m ? m[1] : `${payload.quote_ref || "quote"}.pdf`;
  return { ok: true, bytes, filename };
}

// Send the v2 PDF to the customer via SM8's built-in email (RFT-76).
// Uses /platform_service_email — same endpoint Make's M33 uses for original
// submit, verified working in prod. Worker-direct (no Make), so Andy keeps
// the operator choice on amend the way fresh submit already offers it
// ("send" vs "job only"). Failure mode is non-blocking: the amend itself
// already committed (PDF attached, SM8 updated, row stored); a failed email
// just means the operator needs to follow up out-of-band.
async function sendSm8AmendEmail({ accessToken, client, payload, sm8_job_uuid, attachment_uuid }) {
  const to = (payload.customer_email || "").trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, status: 400, detail: "customer_email_missing_or_invalid" };
  }

  const companyName = client.company_name || "your contractor";
  const subject = `Your updated quote from ${companyName}`;

  const template = (client.email_template || "").trim();
  const total = payload.total != null ? payload.total : "";
  const clientNameSafe = String(payload.client_name || "there").replace(/[<>&]/g, "");
  const companyNameSafe = String(companyName).replace(/[<>&]/g, "");
  // Fallback body used when the operator hasn't configured email_template yet.
  // Plain, neutral, no branding — operators should set their own template via
  // onboarding for the final voice; this keeps amend-send functional rather
  // than 400ing on absent template.
  const fallbackBody = [
    `<p>Hi ${clientNameSafe},</p>`,
    `<p>Please find your updated quote attached. Reference: ${payload.quote_ref || ""}.</p>`,
    total ? `<p>Total (inc. GST): $${total}</p>` : "",
    `<p>Thanks,<br>${companyNameSafe}</p>`,
  ].filter(Boolean).join("\n");
  const htmlBody = template
    ? template
        .replace(/\{client_name\}/g, payload.client_name || "")
        .replace(/\{job_address\}/g, payload.site_address || "")
        .replace(/\{quote_ref\}/g, payload.quote_ref || "")
        .replace(/\{total\}/g, String(total))
    : fallbackBody;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (client.staff_uuid) headers["x-impersonate-uuid"] = client.staff_uuid;

  const body = {
    to,
    subject,
    htmlBody,
    attachments: [attachment_uuid],
    regardingJobUUID: sm8_job_uuid,
  };

  const res = await fetch("https://api.servicem8.com/platform_service_email", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: detail.slice(0, 500) };
  }
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { ok: true, sent_to: to, response_status: res.status, response_body: data };
}

// After amend's new attachment is created, deactivate the prior active
// attachment(s) on the SM8 job so the customer can never accidentally
// approve a superseded version (RFT-33 confirmed deactivation works).
// Andy may want to override this to keep prior versions visible side-by-side —
// tracked on RFT-41.
async function sm8DeactivatePriorAttachments(accessToken, jobUuid, keepAttachmentUuid) {
  const filterUrl = `${SM8_BASE}/Attachment.json?%24filter=related_object_uuid%20eq%20%27${encodeURIComponent(jobUuid)}%27`;
  const listRes = await fetch(filterUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!listRes.ok) {
    return { ok: false, status: listRes.status, detail: "list failed" };
  }
  let list;
  try { list = await listRes.json(); }
  catch { return { ok: false, status: 502, detail: "list invalid json" }; }
  if (!Array.isArray(list)) return { ok: false, status: 502, detail: "list not array" };

  const toDeactivate = list.filter((a) => a && a.uuid !== keepAttachmentUuid && a.active != 0);
  let deactivated = 0;
  const failures = [];
  for (const a of toDeactivate) {
    const r = await fetch(`${SM8_BASE}/Attachment/${a.uuid}.json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    if (r.ok) deactivated++;
    else failures.push({ uuid: a.uuid, status: r.status });
  }
  return { ok: true, total_prior_active: toDeactivate.length, deactivated, failures };
}

async function sm8AttachPdf(accessToken, jobUuid, filename, pdfBytes) {
  // Step 1: create attachment metadata. Field shape mirrors Make's M14
  // (Create Attachment Record) which is verified in production — SM8
  // displays `attachment_name`, not `name`, and uses `file_type` for the
  // extension. Setting these via the wrong field name silently produces
  // an attachment with an auto-generated display name (e.g. "Proposal —
  // <site address>").
  const createRes = await fetch(`${SM8_BASE}/Attachment.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      related_object_uuid: jobUuid,
      related_object: "job",
      attachment_name: filename,
      file_type: ".pdf",
      active: true,
    }),
  });
  if (createRes.status === 403) {
    return { ok: false, status: 502, error: { error: "sm8_scope_missing", scope: "publish_job_attachments", detail: "trial token lacks publish_job_attachments — re-auth via setup.html (Flow D)" } };
  }
  if (!createRes.ok) {
    const detail = await createRes.text().catch(() => "");
    return { ok: false, status: 502, error: { error: "sm8_attach_create_failed", status: createRes.status, detail: detail.slice(0, 500) } };
  }
  const attachUuid = createRes.headers.get("x-record-uuid");
  if (!attachUuid) {
    return { ok: false, status: 502, error: { error: "sm8_attach_uuid_missing", detail: "x-record-uuid absent from Attachment.json response" } };
  }
  // Step 2: upload binary
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([pdfBytes], { type: "application/pdf" }), filename);
  const uploadRes = await fetch(`${SM8_BASE}/Attachment/${attachUuid}.file`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: uploadForm,
  });
  if (!uploadRes.ok) {
    const detail = await uploadRes.text().catch(() => "");
    return { ok: false, status: 502, error: { error: "sm8_attach_upload_failed", status: uploadRes.status, attachment_uuid: attachUuid, detail: detail.slice(0, 500) } };
  }
  return { ok: true, attachment_uuid: attachUuid };
}

async function sm8AppendJobDescription(accessToken, jobUuid, payload, client) {
  // Read existing
  const getRes = await fetch(`${SM8_BASE}/job/${jobUuid}.json`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!getRes.ok) {
    const detail = await getRes.text().catch(() => "");
    return { ok: false, status: 502, error: { error: "sm8_job_read_failed", status: getRes.status, detail: detail.slice(0, 500) } };
  }
  let job;
  try { job = await getRes.json(); } catch { return { ok: false, status: 502, error: { error: "sm8_job_invalid_json" } }; }
  const existing = (job && typeof job.job_description === "string") ? job.job_description : "";

  const labels = buildProposalTypeLabels(client?.proposal_types);
  const newBlock = buildJobDescriptionBlock(payload, labels);
  // Append-only: never replace existing content. Two blank lines between blocks.
  const combined = existing ? `${existing}\n\n${newBlock}` : newBlock;

  const putRes = await fetch(`${SM8_BASE}/job/${jobUuid}.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ job_description: combined }),
  });
  if (putRes.status === 403) {
    return { ok: false, status: 502, error: { error: "sm8_scope_missing", scope: "manage_jobs", detail: "trial token lacks manage_jobs — re-auth via setup.html (Flow D)" } };
  }
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => "");
    return { ok: false, status: 502, error: { error: "sm8_job_description_post_failed", status: putRes.status, detail: detail.slice(0, 500) } };
  }
  return { ok: true, prior_length: existing.length, new_length: combined.length };
}

// ─── RFT-85: SM8 job liveness ──────────────────────────────────────────────
// Both the finder and amend op must exclude/reject rows whose SM8 job is
// deleted (active=0). SM8 does NOT block writes to active=0 jobs (empirically
// confirmed RFT-85), so the guard must be Rafter-side.

async function sm8FetchJobActive(accessToken, jobUuid) {
  const res = await fetch(`${SM8_BASE}/job/${jobUuid}.json`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status === 404) return { ok: true, active: 0, status_text: "not_found" };
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, status: res.status, detail: detail.slice(0, 300) };
  }
  let job;
  try { job = await res.json(); }
  catch { return { ok: false, status: 502, detail: "sm8_job_invalid_json" }; }
  return { ok: true, active: job?.active === 1 ? 1 : 0, status_text: job?.status || "" };
}

// Batched form for the finder: parallel single GETs, returns the Set of
// currently active job UUIDs from the supplied list. SM8 OData rejects
// `or`-joined predicates ("Advanced Record Filter Queries Not Supported"),
// so per-UUID single GETs are the reliable shape. Bounded by finder limit
// (≤50). Returns null only if every call errored — empty Set is a valid
// "nothing live" answer distinct from a SM8 outage.
async function sm8FetchActiveSet(accessToken, jobUuids) {
  if (!jobUuids.length) return new Set();
  const results = await Promise.all(jobUuids.map(async (uuid) => {
    try {
      const res = await fetch(`${SM8_BASE}/job/${uuid}.json`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (res.status === 404) return { ok: true, uuid, active: 0 };
      if (!res.ok) return { ok: false };
      const job = await res.json().catch(() => null);
      const active = job && job.active === 1 ? 1 : 0;
      return { ok: true, uuid, active };
    } catch { return { ok: false }; }
  }));
  if (!results.some((r) => r.ok)) {
    console.error(JSON.stringify({ event: "sm8_active_set_fetch_failed", n: jobUuids.length }));
    return null;
  }
  const liveSet = new Set();
  for (const r of results) {
    if (r.ok && r.active === 1) liveSet.add(r.uuid);
  }
  return liveSet;
}

async function handleAmendQuote(request, env) {
  // RFT-95: per-IP rate limit before auth + parent lookup + SM8 work.
  const rl = await rateLimitOrInternal(request, env, env.RATE_AMEND);
  if (rl) return rl;
  const a = await requireFormOrInternal(request, env);
  if (a.error) return a.error;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json" }, { status: 400 }); }

  const { parent_quote_ref, payload, send_email } = body || {};
  if (!parent_quote_ref || !QUOTE_REF_RE.test(parent_quote_ref)) {
    return json({ error: "invalid_parent_quote_ref" }, { status: 400 });
  }
  if (!payload || typeof payload !== "object") {
    return json({ error: "missing_field", field: "payload" }, { status: 400 });
  }
  // send_email honours the operator's per-amend choice the same way original
  // submit's send_email field does. Default false (job-update-only) if absent.
  const wantsEmail = send_email === true;

  if (!env.RAFTER_QUOTES) {
    return json({ error: "server_misconfigured", detail: "RAFTER_QUOTES binding not set" }, { status: 500 });
  }

  // Load parent
  let parent;
  try {
    parent = await env.RAFTER_QUOTES.prepare("SELECT * FROM quotes WHERE quote_ref = ?").bind(parent_quote_ref).first();
  } catch (e) {
    return json({ error: "d1_read_failed", detail: e.message }, { status: 502 });
  }
  if (!parent) return json({ error: "parent_not_found", parent_quote_ref }, { status: 404 });
  if (a.scopedToUuid && parent.client_uuid !== a.scopedToUuid) {
    return json({ error: "parent_not_found", parent_quote_ref }, { status: 404 });
  }
  if (!parent.sm8_job_uuid || !UUID_RE.test(parent.sm8_job_uuid)) {
    return json({ error: "parent_missing_sm8_job_uuid", detail: "amend impossible — parent row has no SM8 job linkage (RFT-35 SOLE-linkage constraint)" }, { status: 422 });
  }
  if (parent.status === "superseded") {
    return json({ error: "parent_already_superseded", current_status: parent.status, hint: "amend the latest version, not a superseded one" }, { status: 409 });
  }

  // Validate new quote_ref
  const new_quote_ref = payload.quote_ref;
  if (!new_quote_ref || !QUOTE_REF_RE.test(new_quote_ref)) {
    return json({ error: "invalid_payload_quote_ref", hint: "payload.quote_ref must be Q-YYYYMMDD-HHMM" }, { status: 400 });
  }
  if (new_quote_ref === parent_quote_ref) {
    return json({ error: "new_quote_ref_must_differ" }, { status: 400 });
  }

  const client_uuid = parent.client_uuid;
  const sm8_job_uuid = parent.sm8_job_uuid;
  const new_version = (parent.version || 1) + 1;

  // Parent's proposal_date for the PDF banner ("supersedes the version dated …")
  let parentPayload = {};
  try { parentPayload = JSON.parse(parent.payload || "{}"); } catch { /* parent payload corrupt — banner will say "(date unknown)" */ }
  const supersedes_date = parentPayload.proposal_date || "";

  // Enrich payload for PDF worker: version + supersedes context drive both
  // the filename (…-v2.pdf) and the on-face version banner. Stored verbatim
  // in rafter-quotes so future amends can chain.
  const enrichedPayload = {
    ...payload,
    version: new_version,
    parent_ref: parent_quote_ref,
    supersedes_date,
  };

  // Load client config for proposal-type labels + token refresh
  const client = await readClient(env, client_uuid);
  if (!client) return json({ error: "client_not_found", client_uuid }, { status: 404 });

  let accessToken;
  try { accessToken = await refreshTokenIfNeeded(client_uuid, env); }
  catch (e) { return json({ error: "token_refresh_failed", detail: e.message }, { status: 502 }); }

  // RFT-85: refuse to amend into a deleted SM8 job. SM8 does NOT block writes
  // to active=0 jobs (empirically confirmed — a v2 amend landed on a deleted
  // parent job in prod). Block early, before wasting PDF generation.
  const liveness = await sm8FetchJobActive(accessToken, sm8_job_uuid);
  if (!liveness.ok) {
    return json({ error: "sm8_job_fetch_failed", sm8_job_uuid, status: liveness.status, detail: liveness.detail }, { status: 502 });
  }
  if (liveness.active !== 1) {
    return json({
      error: "sm8_job_deleted",
      sm8_job_uuid,
      sm8_status: liveness.status_text,
      detail: "Target SM8 job is deleted (active=0). Cannot amend — create a new quote instead.",
    }, { status: 410 });
  }

  // Generate PDF via PDF_WORKER service binding
  const pdf = await fetchAmendPdf(env, enrichedPayload);
  if (!pdf.ok) return json(pdf.error, { status: pdf.status });

  // SM8 attach (two-step). Filename comes from PDF worker via
  // Content-Disposition so SM8's attachment_name matches the customer-facing
  // filename (e.g. Customer-2026-06-06-Quote-v2.pdf).
  const attach = await sm8AttachPdf(accessToken, sm8_job_uuid, pdf.filename, pdf.bytes);
  if (!attach.ok) return json(attach.error, { status: attach.status });

  // Append job_description version block. If this fails the attachment is
  // already on SM8 — surface clearly. (No automatic rollback; operator can
  // delete the orphan attachment via SM8 UI if needed.)
  const append = await sm8AppendJobDescription(accessToken, sm8_job_uuid, enrichedPayload, client);
  if (!append.ok) {
    // Annotate with the attachment we already created so a human can clean up.
    return json({ ...append.error, attachment_uuid_orphaned: attach.attachment_uuid }, { status: append.status });
  }

  // Deactivate prior attachments — default behaviour (RFT-33 confirmed; RFT-41
  // pending Andy on whether side-by-side comparison wins out for some clients).
  // Non-blocking: if SM8 list/update fails the amend already succeeded; surface
  // the result for visibility but don't roll the row back.
  const deact = await sm8DeactivatePriorAttachments(accessToken, sm8_job_uuid, attach.attachment_uuid);
  if (!deact.ok) {
    console.error(JSON.stringify({ event: "amend_deactivate_prior_failed", sm8_job_uuid, detail: deact.detail || deact.status }));
  }

  // Write new row
  const w = await writeQuoteRow(env, {
    quote_ref: new_quote_ref,
    client_uuid,
    sm8_job_uuid,
    version: new_version,
    parent_ref: parent_quote_ref,
    status: "submitted",
    payload: enrichedPayload,
  });
  if (w.error) {
    // SM8-side committed already — surface but don't roll back. The amend is
    // visible in SM8; the rafter-quotes side will self-correct on next edit.
    console.error(JSON.stringify({ event: "amend_d1_write_failed_after_sm8_commit", parent_quote_ref, new_quote_ref, sm8_job_uuid, attachment_uuid: attach.attachment_uuid }));
    return w.error;
  }

  // Mark parent superseded (non-blocking — main write already succeeded).
  try {
    await env.RAFTER_QUOTES.prepare("UPDATE quotes SET status='superseded', updated_at=? WHERE quote_ref=?")
      .bind(new Date().toISOString(), parent_quote_ref).run();
  } catch (e) {
    console.error(JSON.stringify({ event: "amend_supersede_parent_failed", parent_quote_ref, error: e.message }));
  }

  // Customer email (RFT-76) — Path B: SM8 direct, no Make. Non-blocking;
  // amend has already committed if this fails.
  let emailResult = null;
  if (wantsEmail) {
    try {
      emailResult = await sendSm8AmendEmail({
        accessToken,
        client,
        payload: enrichedPayload,
        sm8_job_uuid,
        attachment_uuid: attach.attachment_uuid,
      });
      if (!emailResult.ok) {
        console.error(JSON.stringify({
          event: "amend_email_failed",
          sm8_job_uuid,
          new_quote_ref,
          status: emailResult.status,
          detail: emailResult.detail,
        }));
      }
    } catch (e) {
      emailResult = { ok: false, detail: e.message };
      console.error(JSON.stringify({ event: "amend_email_uncaught", new_quote_ref, error: e.message }));
    }
  }

  return json({
    ok: true,
    new_quote_ref,
    new_version,
    parent_quote_ref,
    sm8_job_uuid,
    attachment_uuid: attach.attachment_uuid,
    filename: pdf.filename,
    job_description: { prior_length: append.prior_length, new_length: append.new_length },
    prior_attachments: deact.ok
      ? { total_active: deact.total_prior_active, deactivated: deact.deactivated, failures: deact.failures }
      : { error: deact.detail || `status_${deact.status}` },
    email: wantsEmail
      ? (emailResult && emailResult.ok
          ? { sent: true, to: emailResult.sent_to }
          : { sent: false, error: (emailResult && emailResult.detail) || "unknown" })
      : { sent: false, reason: "not_requested" },
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
  if (method === "GET" && path === "/get-form-token") return handleGetFormToken(request, url, env);
  if (method === "POST" && path === "/copy-r2-photos") return handleCopyR2Photos(request, url, env);
  if (method === "GET" && path === "/health") return json({ ok: true });
  if (method === "POST" && path === "/send-test-alert") return handleSendTestAlert(request, env);
  if (method === "POST" && path === "/store-draft") return handleStoreDraft(request, env);
  if (method === "POST" && path === "/store-quote-link") return handleStoreQuoteLink(request, env);
  if (method === "POST" && path === "/amend-quote") return handleAmendQuote(request, env);
  if (method === "GET" && path === "/drafts") return handleListDrafts(request, url, env);
  const draftMatch = method === "GET" && /^\/draft\/(Q-\d{8}-\d{4})$/.exec(path);
  if (draftMatch) return handleGetDraft(request, draftMatch[1], env);

  const clientMatch = method === "GET" && /^\/client\/([0-9a-f-]{36})$/i.exec(path);
  if (clientMatch) return handleReadClient(request, clientMatch[1], env);
  const materialsMatch = method === "GET" && /^\/materials\/([0-9a-f-]{36})$/i.exec(path);
  if (materialsMatch) return handleReadMaterials(request, materialsMatch[1], env);
  const photosMatch = method === "GET" && /^\/photos\/([0-9a-f-]{36})$/i.exec(path);
  if (photosMatch) return handleListPhotos(request, photosMatch[1], env);
  if (method === "GET" && path === "/photo") return handleGetPhoto(request, url, env);
  if (method === "GET" && path === "/sm8-search") return handleSm8Search(request, url, env);
  if (method === "GET" && path === "/sm8-staff") return handleSm8Staff(url, env, request);
  const brandMatch = method === "GET" && /^\/brand\/([a-z0-9_.-]+)$/i.exec(path);
  if (brandMatch) return handleBrandAsset(brandMatch[1], env);
  const logoMatch = method === "GET" && /^\/logo\/([0-9a-f-]{36})$/i.exec(path);
  if (logoMatch) return handleClientLogo(logoMatch[1], env);
  const slugMatch = method === "GET" && /^\/resolve-slug\/([a-z0-9-]+)$/i.exec(path);
  if (slugMatch) return handleResolveSlug(request, slugMatch[1], env);

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
