const SM8_MATERIALS_URL = "https://api.servicem8.com/api_1.0/material.json";
const MATERIALS_TTL_SECONDS = 86400;
const CLIENT_KEY_PREFIX = "client:";
const MATERIALS_KEY_PREFIX = "materials:";

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
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

async function handleRefreshMaterials(url, env) {
  const uuid = url.searchParams.get("uuid");
  if (!uuid) return json({ error: "missing_param", param: "uuid" }, { status: 400 });

  const config = await readClient(env, uuid);
  if (!config) return json({ error: "client_not_found", uuid }, { status: 404 });
  if (!config.access_token) {
    return json({ error: "token_required", detail: "no access_token in client config — run /store-token first" }, { status: 412 });
  }

  const result = await fetchMaterials(config.access_token);
  if (result.status === 401) {
    return json({ error: "token_expired", detail: "SM8 returned 401 — refresh required" }, { status: 401 });
  }
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
  if (!config.access_token) return { uuid, status: "skipped", reason: "no_access_token" };

  const result = await fetchMaterials(config.access_token);
  if (result.status === 401) return { uuid, status: "skipped", reason: "token_expired" };
  if (!result.ok) return { uuid, status: "failed", reason: `sm8_${result.status}` };

  await writeMaterials(env, uuid, result.data);
  const summary = summariseMaterials(result.data);
  return { uuid, status: "ok", count: summary.count, shape: summary.shape };
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/store-token") {
      return handleStoreToken(request, env);
    }
    if (request.method === "GET" && url.pathname === "/refresh-materials") {
      return handleRefreshMaterials(url, env);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    return json({ error: "not_found", path: url.pathname }, { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};
