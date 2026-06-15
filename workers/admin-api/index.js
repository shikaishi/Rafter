import { verifyWebhook } from '@clerk/backend/webhooks';
import { verifyToken } from '@clerk/backend';

// ── Constants ────────────────────────────────────────────────────────────────

const MATERIALS_SYNC = 'https://rafter-materials-sync.will-8e8.workers.dev';
const SM8_BASE = 'https://api.servicem8.com/api_1.0';
const CLIENT_PREFIX = 'client:';
const SLUG_PREFIX = 'slug:';

// Fields that must be non-empty for a client record to be considered complete (REQ-On-39)
const REQUIRED_FIELDS = [
  'uuid', 'slug', 'company_name', 'phone', 'business_address',
  'abn', 'business_email', 'operator_email', 'webhook_url', 'logo_url',
];

// ── Main handler ─────────────────────────────────────────────────────────────

// CORS — two browser origins call admin-api cross-origin:
//   • rafter.deepgreensea.au — onboarding, settings, the operator form
//   • ops.deepgreensea.au   — the platform-operator console (RFT-121/122)
// Both need preflight and the matching Access-Control-Allow-Origin echo on
// the real response (browsers reject a wildcard when credentials are sent).
// The fallback when an unknown Origin sends a preflight is the rafter
// domain — this is defence-in-depth, not a security boundary (the auth
// gates downstream are the real check).
const ALLOWED_ORIGINS = new Set([
  'https://rafter.deepgreensea.au',
  'https://ops.deepgreensea.au',
]);
function resolveOrigin(request) {
  const o = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.has(o) ? o : 'https://rafter.deepgreensea.au';
}
function corsPreflightHeaders(request) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
function withCors(response, request) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', resolveOrigin(request));
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight — must be handled before any auth check
    if (request.method === 'OPTIONS' && (pathname.startsWith('/onboarding/') || pathname.startsWith('/form/') || pathname.startsWith('/settings/') || pathname.startsWith('/console/') || pathname.match(/^\/admin\/clients\/[0-9a-f-]{36}$/i))) {
      return new Response(null, { status: 204, headers: corsPreflightHeaders(request) });
    }

    if (request.method === 'POST' && pathname === '/webhooks/clerk') {
      return handleClerkWebhook(request, env);
    }
    // RFT-30 — tenant self-teardown lives under /admin/ for URL coherence but
    // is Clerk-JWT-gated (not admin-bearer), so the org's own admin can close
    // their account. Intercepted BEFORE the requireBearer block below so the
    // bearer check never fires on this path.
    const deleteClientMatch = request.method === 'DELETE' && pathname.match(/^\/admin\/clients\/([0-9a-f-]{36})$/i);
    if (deleteClientMatch) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error, request);
      return withCors(await handleDeleteClient(deleteClientMatch[1], request, env, payload), request);
    }
    if (pathname.startsWith('/admin/')) {
      const authErr = requireBearer(request, env);
      if (authErr) return authErr;
      return handleAdmin(request, env, url);
    }
    // RFT-122 — platform operator console surface. Separate auth gate from
    // /settings/* (which is org:admin) and from /admin/* (which is admin bearer).
    // platformOperatorGate checks Clerk JWT + sub against PLATFORM_OPERATORS
    // allowlist. Decoupled from org membership so the platform operator can
    // see all tenants regardless of which orgs they belong to.
    if ((request.method === 'POST' || request.method === 'GET') && pathname.startsWith('/console/')) {
      const gate = await platformOperatorGate(request, env);
      if (gate.error) return withCors(gate.error, request);
      return withCors(await handleConsole(request, env, url, gate.payload, gate.userId), request);
    }
    if ((request.method === 'POST' || request.method === 'GET') && pathname.startsWith('/onboarding/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error, request);
      return withCors(await handleOnboarding(request, env, url, payload), request);
    }
    // RFT-87 commit 7: public tenant-mode lookup. Form calls this BEFORE
    // knowing whether to demand a Clerk session — answer comes from the
    // per-tenant gate_enforced flag. No auth. Resolves slug→uuid as a
    // side-effect (replaces the retired /resolve-slug function).
    const tenantModeMatch = request.method === 'GET' && pathname.match(/^\/form\/tenant-mode\/([a-z0-9-]+)$/i);
    if (tenantModeMatch) {
      return withCors(await handleTenantMode(tenantModeMatch[1], env), request);
    }
    // RFT-87 scope (a): /form/* is the verification surface other workers
    // proxy form requests through. Same Clerk-JWT auth as /onboarding/*; the
    // distinction is purpose — /onboarding is for the onboarding flow itself,
    // /form is for runtime tenant-ownership verification from the operator form.
    if ((request.method === 'POST' || request.method === 'GET') && pathname.startsWith('/form/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error, request);
      return withCors(await handleForm(request, env, url, payload), request);
    }
    // RFT-63: /settings/* is the post-onboarding tenant config surface. Same
    // Clerk-JWT gate as /onboarding/*, plus an org:admin role requirement at
    // the handler layer (per RFT-63 decision — start closed, loosen later).
    if (pathname.startsWith('/settings/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error, request);
      return withCors(await handleSettings(request, env, url, payload), request);
    }
    return new Response('Not Found', { status: 404 });
  },
};

// ── Auth guards ──────────────────────────────────────────────────────────────

function requireBearer(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.slice(7) !== env.RAFTER_ADMIN_SECRET) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }
  return null;
}

async function requireClerkJWT(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return { error: json({ ok: false, error: 'Missing authorization' }, 401) };
  try {
    // RFT-122 — CLERK_AUTHORIZED_PARTY supports comma-separated values so
    // both rafter.deepgreensea.au (operator form) and ops.deepgreensea.au
    // (platform console) can present valid JWTs from the same Clerk instance.
    const parties = (env.CLERK_AUTHORIZED_PARTY || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const payload = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: parties.length ? parties : undefined,
    });
    return { payload };
  } catch {
    return { error: json({ ok: false, error: 'Invalid token' }, 401) };
  }
}

// RFT-107 — Clerk session-token org-claim extraction. @clerk/backend@1.34.0's
// verifyToken does NOT normalise v1↔v2 claim shapes (verified against
// clerk/javascript packages/backend/src/tokens/verify.ts — returns raw decoded
// payload). Two token formats in the wild:
//   v1 (legacy):  flat top-level `org_id` / `org_role` / `org_slug`. Role value
//                 carries the `org:` prefix (e.g. "org:admin", "org:member").
//   v2 (current): nested `o: { id, rol, slg }`, plus `v: 2`. Role value is the
//                 short form WITHOUT the `org:` prefix (e.g. "admin", "member").
//                 Prod (2026-06-11) emits v2; test instance was still emitting
//                 v1 until the API version bumped — hence the prod-only bug.
//
// extractOrgId  — v2-first, v1 fallback. Returns the org id string or undefined.
// extractOrgRole — v2-first with `org:` prefix re-applied so every comparison
//                  site (settingsAdminGate, the SM8 connect/disconnect gates,
//                  index.html state.orgRole check) still works against the
//                  unchanged 'org:admin' / 'org:member' string compare.
function extractOrgId(jwtPayload) {
  if (typeof jwtPayload?.o?.id === 'string') return jwtPayload.o.id;
  if (typeof jwtPayload?.org_id === 'string') return jwtPayload.org_id;
  return undefined;
}

function extractOrgRole(jwtPayload) {
  if (typeof jwtPayload?.o?.rol === 'string') return `org:${jwtPayload.o.rol}`;
  if (typeof jwtPayload?.org_role === 'string') return jwtPayload.org_role;
  return null;
}

// ── RFT-122: platform operator gate ──────────────────────────────────────────
// Identity check for the /console/* route class. Orthogonal to org:admin —
// platform operators see all tenants regardless of which Clerk org they
// belong to. PLATFORM_OPERATORS env var is a comma-separated list of Clerk
// user IDs (the `sub` claim on the JWT). Until set, every /console/* call
// returns 403 — fail-closed is the intended posture for a brand-new admin
// surface, deliberately so the rollout window doesn't leave a wide-open
// "see everything" surface.
async function platformOperatorGate(request, env) {
  const { error, payload } = await requireClerkJWT(request, env);
  if (error) return { error };
  const userId = payload?.sub;
  if (!userId) return { error: json({ ok: false, error: 'no_sub_in_jwt' }, 401) };
  const operators = (env.PLATFORM_OPERATORS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!operators.length) {
    return { error: json({
      ok: false, error: 'platform_operators_not_configured',
      detail: 'Set PLATFORM_OPERATORS via wrangler secret put — comma-separated Clerk user IDs.',
    }, 503) };
  }
  if (!operators.includes(userId)) {
    // Include the rejected user_id in the response so the operator can copy
    // their Clerk user_id into PLATFORM_OPERATORS if the allowlist was
    // configured wrong. Not a privacy leak — the caller already knows their
    // own JWT sub.
    return { error: json({ ok: false, error: 'not_platform_operator', user_id: userId }, 403) };
  }
  return { payload, userId };
}

// ── RFT-96: cross-tenant attempt observability ───────────────────────────────
// Three sinks per attempt: console.log for log retention, D1 row for query,
// Telegram alert for live paging. All fire-and-forget — never block or fail
// the 4xx response that triggered them. Telegram + D1 errors are swallowed
// inside the helpers; the outer .catch on the call site is belt-and-braces.
// TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID secrets gracefully no-op when unset
// (log-only path during the rollout window before the secrets are bound).
async function sendTelegramAlert(text, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error(JSON.stringify({ event: 'telegram_alert_skipped', reason: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set' }));
    return;
  }
  const truncated = text.length > 4096 ? text.slice(0, 4093) + '…' : text;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: truncated }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(JSON.stringify({ event: 'telegram_send_failed', status: res.status, body: body.slice(0, 200) }));
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'telegram_send_error', error: e.message }));
  }
}

async function writeD1Event(env, eventType, clientUuid, payload) {
  if (!env.RAFTER_EVENTS) return;
  try {
    await env.RAFTER_EVENTS.prepare(
      'INSERT INTO events (id, client_uuid, event_type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      clientUuid || null,
      eventType,
      new Date().toISOString(),
      payload ? JSON.stringify(payload) : null
    ).run();
  } catch (e) {
    console.error(JSON.stringify({ event: 'd1_write_failed', eventType, error: e.message }));
  }
}

function logCrossTenantAttempt(env, request, details) {
  const event = {
    event: 'cross_tenant_attempt',
    worker: 'admin-api',
    endpoint: details.endpoint || '',
    method: details.method || '',
    requested_uuid: details.requested_uuid || null,
    resolved_uuid: details.resolved_uuid || null,
    detail: details.detail || null,
    source_ip: request?.headers?.get?.('cf-connecting-ip') || null,
    user_agent: (request?.headers?.get?.('user-agent') || '').slice(0, 120),
    occurred_at: new Date().toISOString(),
  };
  console.log(JSON.stringify(event));
  writeD1Event(env, 'cross_tenant_attempt', event.resolved_uuid, event).catch(() => {});
  sendCrossTenantTelegram(env, event).catch(() => {});
}

function sendCrossTenantTelegram(env, ev) {
  const short = (u) => u ? String(u).slice(0, 8) : '?';
  const text =
    `⚠️ Cross-tenant attempt (${ev.worker})\n` +
    `${ev.method} ${ev.endpoint}\n` +
    `requested ${short(ev.requested_uuid)} from scope ${short(ev.resolved_uuid)}\n` +
    `ip ${ev.source_ip || '?'}` + (ev.detail ? `\ndetail: ${String(ev.detail).slice(0, 200)}` : '');
  return sendTelegramAlert(text, env);
}

// ── RFT-70 Option C race lock ────────────────────────────────────────────────
// KV-backed best-effort lock around the SM8 OAuth establish critical section.
// The window between get-and-put is not atomic (KV has no native CAS), so two
// near-simultaneous clicks within the same KV consistency window CAN both pass
// the check. Designed for human-pace concurrency (sub-second double-clicks rare,
// multi-admin OAuth conflicts at minute-pace common). Promote to a Durable
// Object if the failure pattern shows up empirically — see RFT-70 plan.
const CONNECT_LOCK_PREFIX = 'lock:sm8-connect:';
const CONNECT_LOCK_TTL_SECONDS = 60;

async function acquireConnectLock(env, uuid, userId) {
  const key = CONNECT_LOCK_PREFIX + uuid;
  const existing = await env.RAFTER_CLIENTS.get(key).catch(() => null);
  if (existing) {
    let parsed = null;
    try { parsed = JSON.parse(existing); } catch { /* ignore */ }
    return {
      ok: false,
      held_by_user_id: parsed?.user_id ?? null,
      started_at: parsed?.started_at ?? null,
    };
  }
  const value = JSON.stringify({ user_id: userId, started_at: new Date().toISOString() });
  await env.RAFTER_CLIENTS.put(key, value, { expirationTtl: CONNECT_LOCK_TTL_SECONDS });
  return { ok: true };
}

async function releaseConnectLock(env, uuid) {
  await env.RAFTER_CLIENTS.delete(CONNECT_LOCK_PREFIX + uuid);
}

// ── Webhook handler ──────────────────────────────────────────────────────────

async function handleClerkWebhook(request, env) {
  const svixId = request.headers.get('svix-id');
  try {
    const evt = await verifyWebhook(request, { signingSecret: env.CLERK_WEBHOOK_SECRET });
    console.log(JSON.stringify({ event: 'webhook_received', type: evt.type }));

    if (evt.type === 'organization.created') {
      const orgId   = evt.data?.id;
      const orgSlug = evt.data?.slug;
      const orgName = evt.data?.name;

      // REQ-On-13: idempotency guard — check svix-id first (covers Svix retry storms),
      // then clerk_org_id in KV (covers any other duplicate delivery path).
      if (svixId) {
        const seen = await env.RAFTER_CLIENTS.get('svix:' + svixId).catch(() => null);
        if (seen) {
          console.log(JSON.stringify({ event: 'webhook_dedup', svix_id: svixId }));
          return json({ ok: true, type: evt.type, dedup: true });
        }
      }
      if (orgId) {
        const existingUuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
        if (existingUuid) {
          console.log(JSON.stringify({ event: 'webhook_dedup_org', clerk_org_id: orgId, uuid: existingUuid }));
          return json({ ok: true, type: evt.type, dedup: true, uuid: existingUuid });
        }
      }

      // REQ-On-09: provision stub record — full business details arrive via onboarding form (merge-safe).
      // slug intentionally null: operator assigns the URL slug via the onboarding form, never Clerk's auto slug.
      // webhook_url populated by form submission.
      let uuid;
      try {
        ({ uuid } = await provisionClient({
          clerk_org_id: orgId,
          company_name: orgName || 'Unknown',
          slug: null,
          webhook_url: '',
        }, env));
      } catch (err) {
        console.error(JSON.stringify({ event: 'org_provision_error', clerk_org_id: orgId, error: err.message }));
        return json({ ok: false, error: err.message }, 500);
      }

      // Store svix-id for 7 days (Svix retry window) so retries are no-ops
      if (svixId) {
        await env.RAFTER_CLIENTS.put('svix:' + svixId, uuid, { expirationTtl: 7 * 24 * 3600 }).catch(() => {});
      }
      console.log(JSON.stringify({ event: 'org_provisioned', clerk_org_id: orgId, uuid, slug: orgSlug }));
      return json({ ok: true, type: evt.type, uuid });
    }

    return json({ ok: true, type: evt.type });
  } catch (err) {
    return json({ ok: false, error: err.message }, 400);
  }
}

// ── Admin route dispatcher ───────────────────────────────────────────────────

async function handleAdmin(request, env, url) {
  const { method } = request;
  const path = url.pathname;

  if (method === 'POST' && path === '/admin/clients') {
    const body = await parseBody(request);
    if (!body) return json({ ok: false, error: 'Invalid JSON body' }, 400);
    return handleProvision(body, env);
  }

  if (method === 'GET' && path === '/admin/clients') {
    return handleListClients(env);
  }

  if (method === 'GET' && path === '/admin/abn-lookup') {
    return handleAbnLookup(url, env);
  }

  const m = path.match(/^\/admin\/clients\/([0-9a-f-]{36})\/(verify|sync|rotate-secret)$/i);
  if (m) {
    const [, uuid, action] = m;
    if (action === 'verify') return handleVerify(uuid, url, env);
    if (action === 'sync') return handleSync(uuid, env);
    // rotate-secret: REQ-On-26/REQ-On-59 — RAFTER_INTERNAL_SECRET is hardcoded in Make M35;
    // rotation requires a Make handoff or it silently breaks Make→Worker calls (DEBT-06).
    if (action === 'rotate-secret') {
      return json({
        ok: false,
        error: 'Not yet implemented',
        note: 'DEBT-06: rotating RAFTER_INTERNAL_SECRET requires a Make M35 handoff — document before building',
      }, 501);
    }
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// ── Onboarding route dispatcher ──────────────────────────────────────────────

async function handleOnboarding(request, env, url, jwtPayload) {
  const { method } = request;
  const path = url.pathname;

  if (method === 'POST' && path === '/onboarding/provision') {
    const body = await parseBody(request);
    if (!body) return json({ ok: false, error: 'Invalid JSON body' }, 400);
    // RFT-92 F-PROV-1: tenant uuid MUST come from JWT, never the request body.
    // body.uuid would otherwise let any authed caller overwrite any tenant's
    // KV record via provisionClient's merge path and re-point the clerk_org:
    // reverse index. Drop it before forwarding — provisionClient's clerk_org
    // reverse-lookup path (set on body.clerk_org_id below) is the only source.
    delete body.uuid;
    // Scope to JWT org — browser cannot provision outside its own org (REQ-On-28)
    body.clerk_org_id = extractOrgId(jwtPayload) ?? null;
    return handleProvision(body, env);
  }

  if (method === 'POST' && path === '/onboarding/verify') {
    // RFT-92 F-VER-1: tenant uuid MUST come from JWT, never the request body.
    // Previously body.uuid was trusted, letting any authed caller smoketest
    // (and leak slug/company_name from) any tenant's KV record.
    const orgId = extractOrgId(jwtPayload);
    if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
    const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
    if (!uuid) return json({ ok: false, error: 'no_tenant_for_org' }, 404);
    return handleVerify(uuid, url, env);
  }

  if (method === 'GET' && path === '/onboarding/abn-lookup') {
    return handleAbnLookup(url, env);
  }

  if (method === 'GET' && path === '/onboarding/sm8-prefill') {
    return handleSm8Prefill(jwtPayload, env);
  }

  if (method === 'POST' && path === '/onboarding/photos') {
    return handleOnboardingPhotos(request, env, jwtPayload);
  }

  if (method === 'POST' && path === '/onboarding/sm8-callback') {
    return handleSm8Callback(request, env, jwtPayload);
  }

  if (method === 'POST' && path === '/onboarding/sm8-disconnect') {
    return handleSm8Disconnect(request, env, jwtPayload);
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// ── Form route dispatcher (RFT-87 scope a) ───────────────────────────────────
//
// /form/* is the verification surface that materials-sync and pdf proxy the
// operator form's requests through. The form sends its Clerk JWT as a Bearer
// token; service-binding callers (materials-sync, pdf) forward that same JWT
// in the Authorization header — no second auth gate. /form/* is gated by
// requireClerkJWT in the dispatcher (same as /onboarding/*).
//
// The single endpoint here is the cross-tenant verifier: given a target_uuid
// or target_slug, confirm the JWT's org owns that tenant. Single source of
// truth for "does this caller's session map to this tenant" — closes RFT-86.

// RFT-87 commit 7 — public tenant-mode lookup. No auth: the form calls this
// at boot to decide whether to demand a Clerk session at all. Returns the
// tenant's uuid (replaces the retired /resolve-slug function) plus the
// gate_enforced flag from the client KV record.
//
// RFT-87 scope (b) flip (2026-06-11): default is now GATED. Missing
// gate_enforced field is treated as `true` — new tenants are
// closed-by-default. Only an explicit `gate_enforced: false` keeps the
// pre-RFT-87 unauthenticated handler path open. This locks new tenants
// behind the passkey-on-invite flow from the moment they're provisioned.
// Andy (`gate_enforced: false` explicit) is unaffected: explicit false
// still returns false on this endpoint.
//
// Verification:
//   * explicit false (Andy)        → !== false === false → ungated ✓
//   * explicit true (BVT, Dev)     → !== false === true  → gated   ✓
//   * undefined (new tenant)       → !== false === true  → gated   ✓ NEW
async function handleTenantMode(slug, env) {
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return json({ ok: false, error: 'invalid_slug' }, 400);
  }
  // RFT-110: slugs are stored lowercase; lookups normalise so /BVT and /bvt both work.
  const lookup = slug.toLowerCase();
  const uuid = await env.RAFTER_CLIENTS.get(SLUG_PREFIX + lookup).catch(() => null);
  if (!uuid) {
    return json({ ok: false, error: 'slug_not_found', slug: lookup }, 404);
  }
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) {
    return json({ ok: false, error: 'client_not_found', uuid }, 404);
  }
  let config;
  try { config = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }
  const gate_enforced = config.gate_enforced !== false;
  return json({ ok: true, slug: lookup, uuid, gate_enforced });
}

async function handleForm(request, env, url, jwtPayload) {
  const { method } = request;
  const path = url.pathname;

  if (method === 'POST' && path === '/form/verify-tenant') {
    return handleVerifyTenant(request, env, jwtPayload);
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// RFT-87 scope (a) — cross-tenant verifier.
// Input (body):  { target_uuid }  OR  { target_slug }
// Output:        { ok: true, uuid, org_id, role } on match;
//                401 invalid/missing JWT (caught upstream by requireClerkJWT);
//                403 cross_tenant_forbidden — JWT org does not own the target;
//                404 slug/org/uuid not resolvable;
//                400 missing or malformed target.
//
// The cross-tenant gate: even with a valid JWT, an org-A user cannot access
// org-B data. This is the RFT-86 fix at the auth layer.
async function handleVerifyTenant(request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const target_uuid = body?.target_uuid;
  const target_slug = body?.target_slug;
  if (!target_uuid && !target_slug) {
    return json({ ok: false, error: 'missing_target', detail: 'provide target_uuid or target_slug' }, 400);
  }

  // Resolve JWT's org → uuid
  const orgUuid = await env.RAFTER_CLIENTS.get(`clerk_org:${orgId}`).catch(() => null);
  if (!orgUuid) {
    return json({ ok: false, error: 'org_not_provisioned' }, 404);
  }

  // Resolve target uuid (from explicit uuid or via slug lookup)
  let resolvedTargetUuid;
  if (target_uuid) {
    if (typeof target_uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target_uuid)) {
      return json({ ok: false, error: 'invalid_target_uuid' }, 400);
    }
    resolvedTargetUuid = target_uuid;
  } else {
    if (typeof target_slug !== 'string' || !/^[a-z0-9-]+$/i.test(target_slug)) {
      return json({ ok: false, error: 'invalid_target_slug' }, 400);
    }
    // RFT-110: slugs are stored lowercase; lookups normalise.
    const slugLookup = target_slug.toLowerCase();
    const slugUuid = await env.RAFTER_CLIENTS.get(`slug:${slugLookup}`).catch(() => null);
    if (!slugUuid) {
      return json({ ok: false, error: 'slug_not_found', slug: slugLookup }, 404);
    }
    resolvedTargetUuid = slugUuid;
  }

  // Cross-tenant check — the actual RFT-86 fix
  if (orgUuid !== resolvedTargetUuid) {
    // RFT-96 — this is THE detector for the platform-wide cross-tenant gate.
    // Every materials-sync / pdf endpoint that goes through requireFormJWT
    // proxies here, so this single site catches the bulk of attempts. Source
    // IP is the original caller's (service-binding fetches preserve it).
    logCrossTenantAttempt(env, request, {
      endpoint: '/form/verify-tenant',
      method: 'POST',
      requested_uuid: resolvedTargetUuid,
      resolved_uuid: orgUuid,
      detail: target_slug ? `via slug=${target_slug}` : 'via uuid',
    });
    return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);
  }

  return json({
    ok: true,
    uuid: resolvedTargetUuid,
    org_id: orgId,
    role: extractOrgRole(jwtPayload),
  });
}

// ── Settings route dispatcher (RFT-63) ───────────────────────────────────────
//
// Post-onboarding tenant config surface. All endpoints under /settings/* are
// gated by:
//   1. Clerk JWT (dispatcher-level requireClerkJWT — same as /onboarding/*)
//   2. org:admin role (handler-level via settingsAdminGate — same pattern as
//      handleSm8Callback's RFT-70 Option C check)
//
// Decision (RFT-63, 2026-06-08): start fully admin-only. Per-pane tiering can
// loosen later if a tenant asks; clawing back access is hard, granting is easy.
//
// Tenant scoping: JWT.org_id → clerk_org:<org_id> KV → uuid. Endpoints never
// trust a client-supplied uuid — same primitive that closes RFT-86 at /form.

async function handleSettings(request, env, url, jwtPayload) {
  const { method } = request;
  const path = url.pathname;

  // Admin-only gate. Members get a clear 403 with the role they're holding.
  const gateErr = settingsAdminGate(jwtPayload);
  if (gateErr) return gateErr;

  // Tenant uuid is always resolved from the JWT's org — never from input.
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
  const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!uuid) return json({ ok: false, error: 'org_not_provisioned' }, 404);

  if (method === 'GET'  && path === '/settings/state')                     return handleSettingsState(uuid, env);
  if (method === 'POST' && path === '/settings/photos/upload')             return handleSettingsPhotoUpload(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/delete')             return handleSettingsPhotoDelete(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/recategorise')       return handleSettingsPhotoRecategorise(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/copy')               return handleSettingsPhotoCopy(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/bulk-delete')        return handleSettingsPhotoBulkDelete(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/bulk-recategorise')  return handleSettingsPhotoBulkRecategorise(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/bulk-copy')          return handleSettingsPhotoBulkCopy(uuid, request, env);
  if (method === 'POST' && path === '/settings/photos/reorder')            return handleSettingsPhotoReorder(uuid, request, env);
  if (method === 'POST' && path === '/settings/sections/reorder')          return handleSettingsSectionReorder(uuid, request, env);
  if (method === 'POST' && path === '/settings/sections/sync')             return handleSettingsSectionsSync(uuid, env);

  // RFT-102 Phase 3: per-pane config endpoints. Each uses mutateClientRecord
  // and owns ONE slice. Nested-object slices (bank_details, payment_thresholds,
  // branding) deep-merge so a partial save never nulls adjacent keys.
  if (method === 'POST' && path === '/settings/config/business-details')   return handleSettingsConfigBusinessDetails(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/bank-details')       return handleSettingsConfigBankDetails(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/payment-thresholds') return handleSettingsConfigPaymentThresholds(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/terms')              return handleSettingsConfigTerms(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/credentials')        return handleSettingsConfigCredentials(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/email-template')     return handleSettingsConfigEmailTemplate(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/branding')           return handleSettingsConfigBranding(uuid, request, env);
  if (method === 'POST' && path === '/settings/config/quote-title')        return handleSettingsConfigQuoteTitle(uuid, request, env);
  // RFT-102 Phase 3: branding-presets read proxies the pdf worker's PRESETS
  // table via the PDF_WORKER service binding. Single-source — never inline
  // the palette list into settings.html (swatch-vs-PDF drift is the worst
  // branding failure mode).
  if (method === 'GET'  && path === '/settings/branding-presets')          return handleSettingsBrandingPresets(env);

  // RFT-87 scope (b) — Team access pane. Lists members + pending invites +
  // SM8 staff roster in one round-trip. Sends invites via Clerk Backend API
  // with notify=false so the email lands from a Rafter-owned origin/sender
  // and points at a same-origin ticket-accept page (passkey RP ID = our
  // domain). Revoke is admin-initiated cleanup of a pending invite.
  if (method === 'GET'  && path === '/settings/team')                      return handleSettingsTeam(uuid, env, jwtPayload);
  if (method === 'POST' && path === '/settings/team/invites')              return handleSettingsTeamInviteSend(uuid, request, env, jwtPayload);
  if (method === 'POST' && path === '/settings/team/invites/revoke')       return handleSettingsTeamInviteRevoke(uuid, request, env, jwtPayload);
  if (method === 'POST' && path === '/settings/team/members/remove')       return handleSettingsTeamMemberRemove(uuid, request, env, jwtPayload);

  return json({ ok: false, error: 'Not Found', path }, 404);
}

function settingsAdminGate(jwtPayload) {
  const role = extractOrgRole(jwtPayload);
  if (role !== 'org:admin') {
    return json({
      ok: false,
      error: 'role_forbidden',
      code: 'NOT_ADMIN',
      detail: 'Settings access is admin-only. Ask the org admin to make changes.',
      org_role: role,
    }, 403);
  }
  return null;
}

// GET /settings/state — returns everything the settings surface needs in one
// call: tenant record (sanitised), sections (read-only prose from KV), and
// photos grouped by R2 category, sorted by the per-category photo_order
// stored on the client record (RFT-63 Q6 drag-reorder persistence).
async function handleSettingsState(uuid, env) {
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'client_not_found' }, 404);
  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }

  // Sections from KV templates field (set by onboarding seedText, kept in sync
  // by /settings/sections/sync). Read-only prose per RFT-63 Q1. Bundle 3
  // surfaces sm8_template_uuid so the settings UI has a stable identity to
  // reorder by.
  const templates = Array.isArray(record.templates) ? record.templates : [];
  const sections = templates.map(t => ({
    name: t.name || '',
    text: t.text || '',
    sm8_template_uuid: t.sm8_template_uuid || '',
    source: t.source || 'sm8', // RFT-125 — 'rafter' for Rafter-managed sections
  }));

  // Photos grouped by R2 category prefix, sorted by photo_order from the KV
  // record. Mirror handleListPhotos in materials-sync — same per-tenant key
  // shape (clients/<uuid>/photos/<cat>/<file>). Bundle 3: category order
  // mirrors the templates array, so settings-side section reorder flows
  // through to category display.
  const photoOrderMap = (record.photo_order && typeof record.photo_order === 'object') ? record.photo_order : {};
  const templateSlugOrder = templates.map(t => sanitisePathSegment(t.name || ''));
  const photos = await listPhotosByCategory(uuid, env, photoOrderMap, templateSlugOrder);

  return json({
    ok: true,
    uuid,
    company_name: record.company_name || '',
    slug: record.slug || '',
    sections,
    photos,
    // RFT-102 Phase 3: per-pane config slices for the seven Business
    // Configuration cards. Returned together so settings.html can populate
    // every pane from a single round-trip. company_name is duplicated at the
    // top level (existing Phase 2 reader) and inside config (Phase 3 pane).
    config: {
      company_name:         record.company_name || '',
      phone:                record.phone || '',
      business_address:     record.business_address || '',
      abn:                  record.abn || '',
      business_email:       record.business_email || '',
      operator_email:       record.operator_email || '',
      bank_details:         (record.bank_details && typeof record.bank_details === 'object') ? record.bank_details : {},
      payment_thresholds:   (record.payment_thresholds && typeof record.payment_thresholds === 'object') ? record.payment_thresholds : {},
      credentials:          Array.isArray(record.credentials) ? record.credentials : [],
      terms_and_conditions: Array.isArray(record.terms_and_conditions) ? record.terms_and_conditions : [],
      email_template:       record.email_template || '',
      branding:             record.branding ?? null,
      quote_title_format:   record.quote_title_format || '',
    },
    // RFT-118 follow-up: SM8 connection health for the Settings →
    // ServiceM8 connection pane. connected is server-derived (boolean —
    // no token leaked); connected_at + materials_synced_at are ISO strings
    // sourced from the client record. Pane computes green/amber/red from
    // these + the cron cadence (24h/72h thresholds).
    sm8: {
      connected: !!record.access_token,
      connected_at: record.connected_at || null,
      materials_synced_at: record.materials_synced_at || null,
    },
  });
}

async function listPhotosByCategory(uuid, env, photoOrderMap = {}, templateSlugOrder = []) {
  if (!env.RAFTER_ASSETS) return [];
  const prefix = `clients/${uuid}/photos/`;
  const categories = new Map();
  let cursor;
  do {
    const page = await env.RAFTER_ASSETS.list({ prefix, cursor, limit: 1000 });
    for (const obj of page.objects) {
      const rest = obj.key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const category = rest.slice(0, slash);
      const filename = rest.slice(slash + 1);
      if (!filename || filename.includes('/')) continue;
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push({ key: obj.key, filename, size: obj.size, uploaded: obj.uploaded });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // Bundle 3: categories sort by their position in templateSlugOrder (matches
  // admin-side section order). Unknown slugs (R2 prefix with no matching
  // section — should not normally happen post-sync) go to the end
  // alphabetically. For each category: per-photo sort by photo_order, fresh
  // uploads append alphabetically (unchanged from Commit 6).
  const slugIndex = new Map(templateSlugOrder.map((s, i) => [s, i]));
  return [...categories.entries()]
    .sort(([a], [b]) => {
      const ai = slugIndex.has(a) ? slugIndex.get(a) : Infinity;
      const bi = slugIndex.has(b) ? slugIndex.get(b) : Infinity;
      if (ai !== bi) return ai - bi;
      return a.localeCompare(b);
    })
    .map(([name, items]) => {
      const order = Array.isArray(photoOrderMap[name]) ? photoOrderMap[name] : [];
      const orderIndex = new Map(order.map((k, i) => [k, i]));
      const sorted = items.slice().sort((a, b) => {
        const ai = orderIndex.has(a.key) ? orderIndex.get(a.key) : Infinity;
        const bi = orderIndex.has(b.key) ? orderIndex.get(b.key) : Infinity;
        if (ai !== bi) return ai - bi;
        return a.filename.localeCompare(b.filename);
      });
      return { name, photos: sorted };
    });
}

// Helper — atomically read client record, apply a mutation, write back.
// Used by all handlers that touch photo_order or other KV state.
async function mutateClientRecord(uuid, env, mutator) {
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return false;
  let record;
  try { record = JSON.parse(raw); }
  catch { return false; }
  await mutator(record);
  await env.RAFTER_CLIENTS.put(CLIENT_PREFIX + uuid, JSON.stringify(record));
  return true;
}

// Order-list helpers — ensure photo_order is shape { [category]: [key, ...] }
function appendToOrder(record, category, key) {
  if (!record.photo_order || typeof record.photo_order !== 'object') record.photo_order = {};
  if (!Array.isArray(record.photo_order[category])) record.photo_order[category] = [];
  if (!record.photo_order[category].includes(key)) record.photo_order[category].push(key);
}
function removeFromOrder(record, category, key) {
  if (!record.photo_order || !Array.isArray(record.photo_order[category])) return;
  record.photo_order[category] = record.photo_order[category].filter(k => k !== key);
}

// POST /settings/photos/upload — multipart: file + category.
// Reuses sanitisePathSegment + makePhotoFilename (the onboarding-upload primitives).
// Appends the new key to photo_order[category] so it lands at the end of the
// section's list (matches typical add-to-end UX).
async function handleSettingsPhotoUpload(uuid, request, env) {
  let formData;
  try { formData = await request.formData(); }
  catch { return json({ ok: false, error: 'invalid_multipart' }, 400); }
  const file = formData.get('file');
  const category = formData.get('category');
  if (!file || typeof file === 'string') return json({ ok: false, error: 'missing_file' }, 400);
  if (!category) return json({ ok: false, error: 'missing_category' }, 400);
  const safeCategory = sanitisePathSegment(category);
  const safeFilename = makePhotoFilename(file.name || 'photo');
  const key = `clients/${uuid}/photos/${safeCategory}/${safeFilename}`;
  const buffer = await file.arrayBuffer();
  await env.RAFTER_ASSETS.put(key, buffer, { httpMetadata: { contentType: 'image/jpeg' } });
  await mutateClientRecord(uuid, env, (rec) => appendToOrder(rec, safeCategory, key));
  console.log(JSON.stringify({ event: 'settings_photo_uploaded', uuid, key }));
  return json({ ok: true, key, category: safeCategory, filename: safeFilename });
}

// POST /settings/photos/delete — body: { key }
// Tenant-scopes the key against the JWT's uuid (defence in depth — a malicious
// body shouldn't be able to delete a different tenant's photo). Removes from
// photo_order if present.
async function handleSettingsPhotoDelete(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const key = body?.key;
  if (typeof key !== 'string' || !key) return json({ ok: false, error: 'missing_key' }, 400);
  const prefix = `clients/${uuid}/photos/`;
  if (!key.startsWith(prefix)) {
    const keyPrefix = key.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/delete', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `key=${key.slice(0, 120)}` });
    return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);
  }
  await env.RAFTER_ASSETS.delete(key);
  const category = categoryFromKey(key, prefix);
  if (category) {
    await mutateClientRecord(uuid, env, (rec) => removeFromOrder(rec, category, key));
  }
  console.log(JSON.stringify({ event: 'settings_photo_deleted', uuid, key }));
  return json({ ok: true, key });
}

// POST /settings/photos/recategorise — body: { key, to_category }
// R2 has no rename — copy to new key + delete the original. Same tenant-scope
// check on the source key. Removes from source order, appends to dest order.
async function handleSettingsPhotoRecategorise(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const fromKey = body?.key;
  const toCategoryRaw = body?.to_category;
  if (typeof fromKey !== 'string' || !fromKey) return json({ ok: false, error: 'missing_key' }, 400);
  if (typeof toCategoryRaw !== 'string' || !toCategoryRaw) return json({ ok: false, error: 'missing_to_category' }, 400);

  const prefix = `clients/${uuid}/photos/`;
  if (!fromKey.startsWith(prefix)) {
    const keyPrefix = fromKey.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/recategorise', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `key=${fromKey.slice(0, 120)}` });
    return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);
  }

  const fromCategory = categoryFromKey(fromKey, prefix);
  if (!fromCategory) return json({ ok: false, error: 'invalid_key_shape' }, 400);
  const filename = fromKey.slice(prefix.length + fromCategory.length + 1);
  const toCategory = sanitisePathSegment(toCategoryRaw);
  const toKey = `${prefix}${toCategory}/${filename}`;
  if (toKey === fromKey) return json({ ok: true, key: fromKey, noop: true });

  const obj = await env.RAFTER_ASSETS.get(fromKey);
  if (!obj) return json({ ok: false, error: 'source_not_found' }, 404);
  const buffer = await obj.arrayBuffer();
  await env.RAFTER_ASSETS.put(toKey, buffer, { httpMetadata: obj.httpMetadata });
  await env.RAFTER_ASSETS.delete(fromKey);
  await mutateClientRecord(uuid, env, (rec) => {
    removeFromOrder(rec, fromCategory, fromKey);
    appendToOrder(rec, toCategory, toKey);
  });
  console.log(JSON.stringify({ event: 'settings_photo_recategorised', uuid, fromKey, toKey }));
  return json({ ok: true, key: toKey, from_key: fromKey });
}

// POST /settings/photos/copy — body: { key, to_category }
// Same R2 copy as recategorise, but no source delete and source photo_order
// stays intact. If source and dest resolve to the same key (same category)
// it's a no-op. appendToOrder is idempotent (dedupes), so re-copying the same
// photo to the same dest is safe.
async function handleSettingsPhotoCopy(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const fromKey = body?.key;
  const toCategoryRaw = body?.to_category;
  if (typeof fromKey !== 'string' || !fromKey) return json({ ok: false, error: 'missing_key' }, 400);
  if (typeof toCategoryRaw !== 'string' || !toCategoryRaw) return json({ ok: false, error: 'missing_to_category' }, 400);

  const prefix = `clients/${uuid}/photos/`;
  if (!fromKey.startsWith(prefix)) {
    const keyPrefix = fromKey.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/copy', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `key=${fromKey.slice(0, 120)}` });
    return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);
  }

  const fromCategory = categoryFromKey(fromKey, prefix);
  if (!fromCategory) return json({ ok: false, error: 'invalid_key_shape' }, 400);
  const filename = fromKey.slice(prefix.length + fromCategory.length + 1);
  const toCategory = sanitisePathSegment(toCategoryRaw);
  const toKey = `${prefix}${toCategory}/${filename}`;
  if (toKey === fromKey) return json({ ok: true, key: fromKey, noop: true });

  const obj = await env.RAFTER_ASSETS.get(fromKey);
  if (!obj) return json({ ok: false, error: 'source_not_found' }, 404);
  const buffer = await obj.arrayBuffer();
  await env.RAFTER_ASSETS.put(toKey, buffer, { httpMetadata: obj.httpMetadata });
  await mutateClientRecord(uuid, env, (rec) => {
    appendToOrder(rec, toCategory, toKey);
  });
  console.log(JSON.stringify({ event: 'settings_photo_copied', uuid, fromKey, toKey }));
  return json({ ok: true, key: toKey, from_key: fromKey });
}

function categoryFromKey(key, prefix) {
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash >= 0 ? rest.slice(0, slash) : null;
}

// POST /settings/photos/bulk-delete — body: { keys: [...] }
// Per-key tenant-scope check; per-key failure isolated (continue on R2 error,
// report counts). Atomically removes all from photo_order at the end.
async function handleSettingsPhotoBulkDelete(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const keys = body?.keys;
  if (!Array.isArray(keys) || keys.length === 0) return json({ ok: false, error: 'missing_keys' }, 400);
  const prefix = `clients/${uuid}/photos/`;
  const scoped = keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
  if (scoped.length !== keys.length) {
    const bad = keys.find(k => typeof k === 'string' && !k.startsWith(prefix));
    const keyPrefix = bad ? bad.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null : null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/bulk-delete', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `${keys.length - scoped.length} of ${keys.length} keys outside scope` });
    return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);
  }

  let deleted = 0, failed = 0;
  for (const key of scoped) {
    try { await env.RAFTER_ASSETS.delete(key); deleted++; }
    catch (err) { failed++; console.error(JSON.stringify({ event: 'settings_bulk_delete_r2_err', uuid, key, detail: err.message })); }
  }
  await mutateClientRecord(uuid, env, (rec) => {
    for (const key of scoped) {
      const category = categoryFromKey(key, prefix);
      if (category) removeFromOrder(rec, category, key);
    }
  });
  console.log(JSON.stringify({ event: 'settings_photos_bulk_deleted', uuid, deleted, failed }));
  return json({ ok: true, deleted, failed });
}

// POST /settings/photos/bulk-recategorise — body: { keys: [...], to_category }
// Per-key copy + delete in R2. Atomic photo_order update at the end.
async function handleSettingsPhotoBulkRecategorise(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const keys = body?.keys;
  const toCategoryRaw = body?.to_category;
  if (!Array.isArray(keys) || keys.length === 0) return json({ ok: false, error: 'missing_keys' }, 400);
  if (typeof toCategoryRaw !== 'string' || !toCategoryRaw) return json({ ok: false, error: 'missing_to_category' }, 400);
  const prefix = `clients/${uuid}/photos/`;
  const scoped = keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
  if (scoped.length !== keys.length) {
    const bad = keys.find(k => typeof k === 'string' && !k.startsWith(prefix));
    const keyPrefix = bad ? bad.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null : null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/bulk-recategorise', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `${keys.length - scoped.length} of ${keys.length} keys outside scope` });
    return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);
  }
  const toCategory = sanitisePathSegment(toCategoryRaw);

  const moves = []; // [{ fromKey, toKey, fromCategory }]
  let moved = 0, failed = 0;
  for (const fromKey of scoped) {
    const fromCategory = categoryFromKey(fromKey, prefix);
    if (!fromCategory) { failed++; continue; }
    if (fromCategory === toCategory) { continue; } // no-op for same-category
    const filename = fromKey.slice(prefix.length + fromCategory.length + 1);
    const toKey = `${prefix}${toCategory}/${filename}`;
    try {
      const obj = await env.RAFTER_ASSETS.get(fromKey);
      if (!obj) { failed++; continue; }
      const buffer = await obj.arrayBuffer();
      await env.RAFTER_ASSETS.put(toKey, buffer, { httpMetadata: obj.httpMetadata });
      await env.RAFTER_ASSETS.delete(fromKey);
      moves.push({ fromKey, toKey, fromCategory });
      moved++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ event: 'settings_bulk_recat_r2_err', uuid, fromKey, detail: err.message }));
    }
  }
  await mutateClientRecord(uuid, env, (rec) => {
    for (const m of moves) {
      removeFromOrder(rec, m.fromCategory, m.fromKey);
      appendToOrder(rec, toCategory, m.toKey);
    }
  });
  console.log(JSON.stringify({ event: 'settings_photos_bulk_recategorised', uuid, moved, failed }));
  return json({ ok: true, moved, failed });
}

// POST /settings/photos/bulk-copy — body: { keys: [...], to_category }
// Per-key R2 get + R2 put against the dest key (no delete). Same-category
// keys skip silently. appendToOrder is idempotent for repeat copies.
async function handleSettingsPhotoBulkCopy(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const keys = body?.keys;
  const toCategoryRaw = body?.to_category;
  if (!Array.isArray(keys) || keys.length === 0) return json({ ok: false, error: 'missing_keys' }, 400);
  if (typeof toCategoryRaw !== 'string' || !toCategoryRaw) return json({ ok: false, error: 'missing_to_category' }, 400);
  const prefix = `clients/${uuid}/photos/`;
  const scoped = keys.filter(k => typeof k === 'string' && k.startsWith(prefix));
  if (scoped.length !== keys.length) {
    const bad = keys.find(k => typeof k === 'string' && !k.startsWith(prefix));
    const keyPrefix = bad ? bad.match(/^clients\/([0-9a-f-]{36})\//i)?.[1] || null : null;
    logCrossTenantAttempt(env, request, { endpoint: '/settings/photos/bulk-copy', method: 'POST', requested_uuid: keyPrefix, resolved_uuid: uuid, detail: `${keys.length - scoped.length} of ${keys.length} keys outside scope` });
    return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);
  }
  const toCategory = sanitisePathSegment(toCategoryRaw);

  const copies = []; // [{ toKey }]
  let copied = 0, failed = 0;
  for (const fromKey of scoped) {
    const fromCategory = categoryFromKey(fromKey, prefix);
    if (!fromCategory) { failed++; continue; }
    if (fromCategory === toCategory) { continue; } // no-op for same-category
    const filename = fromKey.slice(prefix.length + fromCategory.length + 1);
    const toKey = `${prefix}${toCategory}/${filename}`;
    try {
      const obj = await env.RAFTER_ASSETS.get(fromKey);
      if (!obj) { failed++; continue; }
      const buffer = await obj.arrayBuffer();
      await env.RAFTER_ASSETS.put(toKey, buffer, { httpMetadata: obj.httpMetadata });
      copies.push({ toKey });
      copied++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ event: 'settings_bulk_copy_r2_err', uuid, fromKey, detail: err.message }));
    }
  }
  await mutateClientRecord(uuid, env, (rec) => {
    for (const c of copies) appendToOrder(rec, toCategory, c.toKey);
  });
  console.log(JSON.stringify({ event: 'settings_photos_bulk_copied', uuid, copied, failed }));
  return json({ ok: true, copied, failed });
}

// POST /settings/photos/reorder — body: { category, key_order: [key, ...] }
// Replaces photo_order[category] with the supplied order. Validates: every
// key in the new order is tenant-scoped + lives in the named category. Keys
// not in key_order keep their slot — but absence after a known prior listing
// usually means the client just sent the rendered ordering, so we treat
// key_order as authoritative for the listed keys.
async function handleSettingsPhotoReorder(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const categoryRaw = body?.category;
  const keyOrder = body?.key_order;
  if (typeof categoryRaw !== 'string' || !categoryRaw) return json({ ok: false, error: 'missing_category' }, 400);
  if (!Array.isArray(keyOrder)) return json({ ok: false, error: 'missing_key_order' }, 400);
  const category = sanitisePathSegment(categoryRaw);
  const catPrefix = `clients/${uuid}/photos/${category}/`;
  for (const k of keyOrder) {
    if (typeof k !== 'string' || !k.startsWith(catPrefix)) {
      return json({ ok: false, error: 'invalid_key_in_order', detail: 'all keys must be in the named category for this tenant' }, 400);
    }
  }
  await mutateClientRecord(uuid, env, (rec) => {
    if (!rec.photo_order || typeof rec.photo_order !== 'object') rec.photo_order = {};
    rec.photo_order[category] = keyOrder.slice(); // copy
  });
  console.log(JSON.stringify({ event: 'settings_photos_reordered', uuid, category, count: keyOrder.length }));
  return json({ ok: true, category, count: keyOrder.length });
}

// POST /settings/sections/reorder — body: { order: [sm8_template_uuid, ...] }
//
// Reorders record.templates to match the supplied uuid list. Sections with a
// uuid not present in the order list are appended at the end in their prior
// order (defensive — shouldn't normally happen since the UI sends the full
// known set, but it means a stale tab can't drop rows). Sections without any
// sm8_template_uuid (pre-Bundle-2 backfill, hypothetical) are appended last.
//
// This is the source of truth for section order across the platform:
//   - admin-api handleSettingsState returns sections in this order
//   - admin-api listPhotosByCategory sorts category list by this order
//   - materials-sync handleListPhotos mirrors the same sort
//   - the form photo picker carousel renders in this order
//   - PDF section rendering inherits from the form payload, which inherits
//     from the picker order
// Settings reorder = picker reorder = PDF reorder. One lever.
async function handleSettingsSectionReorder(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const order = body?.order;
  if (!Array.isArray(order)) return json({ ok: false, error: 'missing_order' }, 400);
  if (order.some(u => typeof u !== 'string' || !u)) return json({ ok: false, error: 'invalid_uuid_in_order' }, 400);

  let applied = 0;
  let totalRows = 0;
  const ok = await mutateClientRecord(uuid, env, (rec) => {
    if (!Array.isArray(rec.templates)) return;
    const byUuid = new Map();
    const noUuidRows = [];
    for (const t of rec.templates) {
      if (t.sm8_template_uuid) byUuid.set(t.sm8_template_uuid, t);
      else noUuidRows.push(t);
    }
    const positioned = [];
    const seen = new Set();
    for (const u of order) {
      const t = byUuid.get(u);
      if (t && !seen.has(u)) {
        positioned.push(t);
        seen.add(u);
        applied++;
      }
    }
    // Append uuid-ed rows the caller didn't include (defensive)
    for (const t of rec.templates) {
      if (t.sm8_template_uuid && !seen.has(t.sm8_template_uuid)) {
        positioned.push(t);
        seen.add(t.sm8_template_uuid);
      }
    }
    positioned.push(...noUuidRows);
    rec.templates = positioned;
    totalRows = positioned.length;
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);

  console.log(JSON.stringify({ event: 'settings_sections_reordered', uuid, applied, total: totalRows }));
  return json({ ok: true, applied, total: totalRows });
}

// POST /settings/sections/sync — mirror SM8 active templates onto Rafter.
//
// Bundle 2 (RFT-63, 2026-06-08) rewrote the prior "add-only" sync into a
// full mirror: SM8 is canonical, Rafter equals SM8's active template set
// after every sync. The earlier "never removes templates that disappeared
// from SM8 (protects quote history)" rule was retired — quote history is
// the PDF stored on the SM8 job, not the local prose array, so there is
// nothing to protect by keeping orphan rows around.
//
// Template identity is sm8_template_uuid. First-run backfill matches
// existing Rafter entries to SM8 by name and stamps the uuid; thereafter
// uuid alone drives the diff. That makes rename a uuid-match (same row,
// new name + new prose, photos migrated) instead of a remove+add pair
// that would orphan the old slug's photos.
//
// Diff outcomes per template:
//   - Add:    SM8 uuid not in Rafter → clone-read prose, append.
//   - Update: uuid in both, edit_date matches → no-op. edit_date differs
//             → re-clone for fresh prose, stamp new edit_date.
//   - Rename: special case of Update where the name also differs. Photo
//             slug changes (sanitisePathSegment(name)), so we R2-move every
//             object under old slug to new slug AND rewrite the photo_order
//             key + per-key path strings.
//   - Remove: Rafter row whose uuid no longer appears in SM8 (or whose
//             uuid never backfilled because no name match) → drop the row,
//             delete every R2 object under its slug, prune the photo_order
//             entry.
//
// SM8 read mechanism unchanged from RFT-80 / RFT-84: clone template → GET
// job → read prose → soft-delete the clone. Transactional cleanup of all
// created clone jobs in finally{} regardless of which step failed.
//
// Safeguard: if SM8 returns an empty active-template list while Rafter has
// templates, the call aborts with EMPTY_SM8_REFUSE_WIPE. A token blip or
// OAuth misconfig must not silently wipe a tenant's configured prose.
//
// Returns: { ok, total, added: [name], updated: [name],
//   renamed: [{ old, new, photo_count }],
//   removed: [{ name, photo_count }],
//   unchanged_count, failed: [...] }
async function handleSettingsSectionsSync(uuid, env) {
  // Refresh SM8 token via materials-sync
  try {
    const syncRes = await syncFetch(env, `/refresh-materials?uuid=${uuid}`);
    if (!syncRes.ok) {
      const detail = await syncRes.text().catch(() => String(syncRes.status));
      return json({ ok: false, error: `Token refresh failed: ${detail.slice(0, 200)}`, code: 'REFRESH_FAILED' }, 422);
    }
  } catch (err) {
    return json({ ok: false, error: `Token refresh error: ${err.message}`, code: 'REFRESH_FAILED' }, 502);
  }

  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'client_not_found' }, 404);
  const record = JSON.parse(raw);
  const token = record.access_token;
  if (!token) return json({ ok: false, error: 'no_sm8_token', code: 'NO_TOKEN' }, 422);

  // List SM8 active templates → [{ uuid, name, edit_date, active, ... }]
  const listRes = await fetch(`${SM8_BASE}/jobtemplate.json?$filter=active eq 1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    const detail = await listRes.text().catch(() => '');
    return json({ ok: false, error: 'sm8_list_failed', status: listRes.status, detail: detail.slice(0, 200) }, 502);
  }
  let sm8Templates;
  try { sm8Templates = await listRes.json(); }
  catch { return json({ ok: false, error: 'sm8_invalid_response' }, 502); }
  if (!Array.isArray(sm8Templates)) sm8Templates = [];
  const activeTemplates = sm8Templates.filter(t => t && t.active !== 0 && t.uuid && typeof t.name === 'string' && t.name.trim());

  const existing = Array.isArray(record.templates) ? record.templates.slice() : [];

  // RFT-125 — Rafter-managed sections (source: "rafter") are outside the SM8
  // mirror's scope. Separate them up front; the SM8 diff only operates on
  // SM8-derived entries. Rafter-managed entries are stitched back into the
  // survivors list at the end with their order preserved.
  const isRafterManaged = (e) => e && e.source === 'rafter';
  const rafterManaged = existing.filter(isRafterManaged);
  const sm8Existing = existing.filter(e => !isRafterManaged(e));

  // Safeguard: SM8 came back empty while Rafter has SM8-derived templates.
  // Almost certainly a token blip or OAuth misconfig on SM8's side. Refuse
  // rather than wipe the tenant on one bad response. Rafter-managed
  // sections are excluded from the count — a tenant with only a
  // Miscellaneous (source: rafter) entry has no SM8 templates to lose, so
  // this branch must not fire and block the sync.
  if (activeTemplates.length === 0 && sm8Existing.length > 0) {
    return json({
      ok: false,
      error: 'sm8_returned_empty_with_existing_local',
      code: 'EMPTY_SM8_REFUSE_WIPE',
      detail: `SM8 reported 0 active templates but Rafter has ${sm8Existing.length}. Refusing to wipe. Re-check the SM8 OAuth grant and retry.`,
    }, 502);
  }

  // First-run uuid backfill: any SM8-derived Rafter entry without
  // sm8_template_uuid gets matched to an SM8 entry by name. One-time
  // migration from name-keyed to uuid-keyed identity. After this, uuid
  // alone drives the diff — including rename detection. Rafter-managed
  // entries (source: "rafter") are skipped — they never get an SM8 uuid.
  const sm8ByName = new Map(activeTemplates.map(t => [t.name.trim(), t]));
  for (const entry of sm8Existing) {
    if (!entry.sm8_template_uuid) {
      const match = sm8ByName.get((entry.name || '').trim());
      if (match) entry.sm8_template_uuid = match.uuid;
    }
  }

  const existingByUuid = new Map();
  for (const entry of sm8Existing) {
    if (entry.sm8_template_uuid) existingByUuid.set(entry.sm8_template_uuid, entry);
  }

  // Diff — operates on sm8Existing only. Rafter-managed entries skip the
  // entire add/update/remove machinery and are merged back at write time.
  const toAdd = [];
  const toUpdate = []; // [{ rafterEntry, sm8Tpl, isRename }]
  const unchanged = [];
  for (const sm8Tpl of activeTemplates) {
    const rafterEntry = existingByUuid.get(sm8Tpl.uuid);
    if (!rafterEntry) {
      toAdd.push(sm8Tpl);
      continue;
    }
    const editChanged = !rafterEntry.sm8_edit_date || rafterEntry.sm8_edit_date !== (sm8Tpl.edit_date || '');
    const nameChanged = (rafterEntry.name || '').trim() !== sm8Tpl.name.trim();
    if (editChanged || nameChanged) {
      toUpdate.push({ rafterEntry, sm8Tpl, isRename: nameChanged });
    } else {
      unchanged.push(rafterEntry.name);
    }
  }
  const activeUuidSet = new Set(activeTemplates.map(t => t.uuid));
  // toRemove: SM8-derived entries whose sm8_template_uuid is gone (or never
  // backfilled). Rafter-managed entries are NOT eligible for removal — they
  // sit alongside the SM8 mirror, not inside it.
  const toRemove = sm8Existing.filter(e => !e.sm8_template_uuid || !activeUuidSet.has(e.sm8_template_uuid));

  // Working copy holds the SM8-derived survivors. Rafter-managed entries are
  // appended below after the SM8 diff completes; their relative order is
  // preserved from the existing record.
  const survivors = sm8Existing.filter(e => !toRemove.includes(e));

  const createdJobUuids = [];
  const added = [];
  const updated = [];
  const renamed = []; // [{ old, new, photo_count }]
  const removed = []; // [{ name, photo_count }]
  const failed = [];

  try {
    // ── REMOVE ──────────────────────────────────────────────────────────
    for (const entry of toRemove) {
      const slug = sanitisePathSegment(entry.name || '');
      const r2Keys = slug ? await listR2KeysUnder(env, `clients/${uuid}/photos/${slug}/`) : [];
      for (const key of r2Keys) {
        try { await env.RAFTER_ASSETS.delete(key); }
        catch (err) { failed.push({ name: entry.name, step: 'remove_r2', key, detail: err.message }); }
      }
      if (slug && record.photo_order && record.photo_order[slug]) delete record.photo_order[slug];
      removed.push({ name: entry.name, photo_count: r2Keys.length });
    }

    // ── UPDATE (re-clone prose; on rename also migrate R2 + photo_order) ─
    for (const { rafterEntry, sm8Tpl, isRename } of toUpdate) {
      let prose;
      try { prose = await cloneReadProse(token, sm8Tpl.uuid, createdJobUuids); }
      catch (err) { failed.push({ name: sm8Tpl.name, step: err.step || 'update', detail: err.message }); continue; }

      if (isRename) {
        const oldSlug = sanitisePathSegment(rafterEntry.name || '');
        const newSlug = sanitisePathSegment(sm8Tpl.name);
        let migrated = 0;
        if (oldSlug && newSlug && oldSlug !== newSlug) {
          const r2Keys = await listR2KeysUnder(env, `clients/${uuid}/photos/${oldSlug}/`);
          for (const oldKey of r2Keys) {
            const filename = oldKey.slice(`clients/${uuid}/photos/${oldSlug}/`.length);
            const newKey = `clients/${uuid}/photos/${newSlug}/${filename}`;
            try {
              const obj = await env.RAFTER_ASSETS.get(oldKey);
              if (!obj) continue;
              const buffer = await obj.arrayBuffer();
              await env.RAFTER_ASSETS.put(newKey, buffer, { httpMetadata: obj.httpMetadata });
              await env.RAFTER_ASSETS.delete(oldKey);
              migrated++;
            } catch (err) {
              failed.push({ name: sm8Tpl.name, step: 'rename_r2', key: oldKey, detail: err.message });
            }
          }
          // photo_order migration: rename the key + rewrite per-key paths.
          if (record.photo_order && Array.isArray(record.photo_order[oldSlug])) {
            const remapped = record.photo_order[oldSlug].map(k =>
              k.replace(`/photos/${oldSlug}/`, `/photos/${newSlug}/`)
            );
            if (Array.isArray(record.photo_order[newSlug])) {
              // Defensive merge — should not normally fire.
              for (const k of remapped) {
                if (!record.photo_order[newSlug].includes(k)) record.photo_order[newSlug].push(k);
              }
            } else {
              record.photo_order[newSlug] = remapped;
            }
            delete record.photo_order[oldSlug];
          }
        }
        renamed.push({ old: rafterEntry.name, new: sm8Tpl.name, photo_count: migrated });
      } else {
        updated.push(sm8Tpl.name);
      }

      rafterEntry.name = sm8Tpl.name;
      rafterEntry.text = prose;
      rafterEntry.sm8_edit_date = sm8Tpl.edit_date || '';
      rafterEntry.sm8_template_uuid = sm8Tpl.uuid;
    }

    // ── ADD ─────────────────────────────────────────────────────────────
    // Bundle 3: new sync-added sections prepend to the TOP of the list,
    // preserving SM8's order among the new arrivals. Admin can drag them
    // down later — putting them at the top makes additions noticeable
    // rather than buried at the bottom.
    const newEntries = [];
    for (const sm8Tpl of toAdd) {
      let prose;
      try { prose = await cloneReadProse(token, sm8Tpl.uuid, createdJobUuids); }
      catch (err) { failed.push({ name: sm8Tpl.name, step: err.step || 'add', detail: err.message }); continue; }
      newEntries.push({
        name: sm8Tpl.name,
        text: prose,
        sm8_edit_date: sm8Tpl.edit_date || '',
        sm8_template_uuid: sm8Tpl.uuid,
      });
      added.push(sm8Tpl.name);
    }
    if (newEntries.length) survivors.unshift(...newEntries);

    // RFT-125 — re-attach Rafter-managed sections (source: "rafter") that
    // sat outside the SM8 mirror diff. They append after the SM8-derived
    // survivors so admin-set drag order on SM8 sections isn't disturbed.
    // Their own relative order among themselves is preserved.
    if (rafterManaged.length) survivors.push(...rafterManaged);

    // RFT-125 — auto-Miscellaneous fallback. If the post-sync templates list
    // is empty (SM8 had 0 templates AND there were no Rafter-managed
    // entries — i.e. a never-onboarded-prior tenant whose SM8 has no
    // templates yet), inject one Miscellaneous so the form picker has at
    // least one bucket. The EMPTY_SM8_REFUSE_WIPE guard above ensures
    // we don't hit this branch via a token blip.
    if (survivors.length === 0) {
      survivors.push(DEFAULT_MISC_TEMPLATE());
      added.push('Miscellaneous (auto-injected)');
    }

    // photo_order defence in depth — drop entries for slugs no section now
    // claims. Covers cases where a remove or rename touched a slug that the
    // per-step code somehow missed.
    if (record.photo_order && typeof record.photo_order === 'object') {
      const activeSlugs = new Set(survivors.map(s => sanitisePathSegment(s.name || '')));
      for (const slug of Object.keys(record.photo_order)) {
        if (!activeSlugs.has(slug)) delete record.photo_order[slug];
      }
    }

    record.templates = survivors;
    await env.RAFTER_CLIENTS.put(CLIENT_PREFIX + uuid, JSON.stringify(record));
  } finally {
    // Transactional cleanup — soft-delete every clone job we created
    for (const jobUuid of createdJobUuids) {
      try {
        const delRes = await fetch(`${SM8_BASE}/job/${jobUuid}.json`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!delRes.ok) {
          console.error(JSON.stringify({ event: 'sections_sync_cleanup_failed', uuid, jobUuid, status: delRes.status }));
        }
      } catch (err) {
        console.error(JSON.stringify({ event: 'sections_sync_cleanup_exception', uuid, jobUuid, detail: err.message }));
      }
    }
  }

  console.log(JSON.stringify({
    event: 'settings_sections_synced',
    uuid,
    total: survivors.length,
    added: added.length,
    updated: updated.length,
    renamed: renamed.length,
    removed: removed.length,
    unchanged: unchanged.length,
    failed: failed.length,
    clones_created: createdJobUuids.length,
  }));
  return json({
    ok: true,
    total: survivors.length,
    added,
    updated,
    renamed,
    removed,
    unchanged_count: unchanged.length,
    failed,
  });
}

// ── RFT-102 Phase 3 — per-pane config endpoints ──────────────────────────────
//
// Pattern (every pane):
//   1. parseBody → 400 invalid_json on malformed
//   2. rejectForbiddenConfigKeys → 400 if body carries slug / OAuth / clerk_org
//      / Phase-2-owned keys. Never trust a client-supplied tenant identity.
//   3. validate the pane's own slice (per-handler)
//   4. mutateClientRecord(uuid, env, mutator) — atomic read-modify-write
//   5. 200 { ok, fields } on success; 404 client_not_found if KV miss
//
// Why dedicated endpoints and not /onboarding/provision: provision is
// shallow-merge and header-taxed (requires slug + company_name + webhook_env
// in every call). Per-pane endpoints carry no header tax (uuid resolved from
// JWT org) and deep-merge nested objects, so a partial save of bank_details
// or branding never nulls adjacent keys.

// Keys a settings/config/* endpoint must NEVER accept from the client.
// slug / webhook_env / webhook_url / OAuth tokens / clerk_org_id / gate flag
// are admin-or-provisioning-only. templates / photo_order are owned by the
// Phase 2 sections endpoints. uuid / logo_url are derived server-side.
const FORBIDDEN_CONFIG_KEYS = new Set([
  'slug', 'webhook_env', 'webhook_url',
  'access_token', 'refresh_token', 'expires_at', 'sm8_uuid',
  'clerk_org_id', 'gate_enforced',
  'uuid', 'logo_url',
  'templates', 'photo_order',
  'staff_uuid',
]);

function rejectForbiddenConfigKeys(body) {
  if (!body || typeof body !== 'object') return null;
  const present = Object.keys(body).filter(k => FORBIDDEN_CONFIG_KEYS.has(k));
  if (present.length) {
    return json({
      ok: false, error: 'forbidden_keys', keys: present,
      detail: 'These keys are not editable via /settings/config — use the appropriate admin or provisioning surface.',
    }, 400);
  }
  return null;
}

// Pull only string values for the named keys out of body. Trim whitespace,
// reject non-string with a per-field error. Returns { fields, errors } where
// fields = { key: trimmed } for every key explicitly present in body.
function pickStringFields(body, keys, opts = {}) {
  const fields = {};
  const errors = [];
  const maxLen = opts.maxLen ?? 2000;
  for (const k of keys) {
    if (body[k] === undefined) continue;
    const v = body[k];
    if (v === null) { fields[k] = ''; continue; } // explicit clear
    if (typeof v !== 'string') { errors.push(`${k}_not_string`); continue; }
    if (v.length > maxLen) { errors.push(`${k}_too_long`); continue; }
    fields[k] = v.trim();
  }
  return { fields, errors };
}

// 1 of 7 — business details (6 scalar fields). Empty-string clears OK; the
// onboarding form enforces company_name required, but here we allow rename
// without re-providing it (omit the key → leave existing value). To clear,
// caller sends '' or null. company_name reset to '' would put the record in
// an inconsistent state per the provision invariant, so we reject empty
// company_name explicitly.
async function handleSettingsConfigBusinessDetails(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const SCALAR_KEYS = ['company_name', 'phone', 'business_address', 'abn', 'business_email', 'operator_email'];
  const { fields, errors } = pickStringFields(body, SCALAR_KEYS, { maxLen: 500 });
  if (errors.length) return json({ ok: false, error: 'invalid_fields', errors }, 400);

  if (fields.company_name !== undefined && fields.company_name === '') {
    return json({ ok: false, error: 'company_name_required', detail: 'company_name cannot be empty.' }, 400);
  }

  const ok = await mutateClientRecord(uuid, env, (record) => {
    Object.assign(record, fields);
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, fields: Object.keys(fields) });
}

// 2 of 7 — bank details. Shape: { name, bsb, account }. Deep-merge: only
// keys present in body override; absent keys preserve existing. Send null to
// explicitly clear a sub-key.
async function handleSettingsConfigBankDetails(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const bd = body.bank_details;
  if (bd === undefined) return json({ ok: false, error: 'missing_bank_details' }, 400);
  if (bd === null || typeof bd !== 'object' || Array.isArray(bd)) {
    return json({ ok: false, error: 'bank_details_must_be_object' }, 400);
  }
  const { fields, errors } = pickStringFields(bd, ['name', 'bsb', 'account'], { maxLen: 100 });
  if (errors.length) return json({ ok: false, error: 'invalid_bank_details', errors }, 400);

  const ok = await mutateClientRecord(uuid, env, (record) => {
    const existing = (record.bank_details && typeof record.bank_details === 'object') ? record.bank_details : {};
    record.bank_details = { ...existing, ...fields };
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, fields: Object.keys(fields) });
}

// 3 of 7 — payment thresholds. Shape: { tier_key: "50/50" | [50,50] }. Deep-
// merge per tier; tiers not present in body are preserved. Arrays normalise
// to slash-strings the same way provisionClient does (KV stores strings;
// index.html parseSplit() relies on "/" delimiter).
async function handleSettingsConfigPaymentThresholds(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const pt = body.payment_thresholds;
  if (pt === undefined) return json({ ok: false, error: 'missing_payment_thresholds' }, 400);
  if (pt === null || typeof pt !== 'object' || Array.isArray(pt)) {
    return json({ ok: false, error: 'payment_thresholds_must_be_object' }, 400);
  }

  const normalised = {};
  const errors = [];
  const VALID_TIER_RE = /^[a-z0-9_]+$/i;
  for (const [tier, value] of Object.entries(pt)) {
    if (!VALID_TIER_RE.test(tier)) { errors.push(`invalid_tier_key:${tier}`); continue; }
    let str;
    if (Array.isArray(value)) str = value.join('/');
    else if (typeof value === 'string') str = value;
    else { errors.push(`tier_${tier}_not_string_or_array`); continue; }
    if (str.length > 100) { errors.push(`tier_${tier}_too_long`); continue; }
    // Loose format check — digits / commas / slashes / whitespace only. Sum-
    // to-100 enforcement stays client-side (already in onboarding.html);
    // server keeps the floor permissive so a partial-update can leave a tier
    // temporarily wrong without 500ing.
    if (!/^[\d,\s/]+$/.test(str)) { errors.push(`tier_${tier}_bad_format`); continue; }
    normalised[tier] = str.replace(/\s+/g, '').split(',').map(s => s.trim()).filter(Boolean).join('/');
  }
  if (errors.length) return json({ ok: false, error: 'invalid_payment_thresholds', errors }, 400);

  const ok = await mutateClientRecord(uuid, env, (record) => {
    const existing = (record.payment_thresholds && typeof record.payment_thresholds === 'object') ? record.payment_thresholds : {};
    record.payment_thresholds = { ...existing, ...normalised };
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, tiers: Object.keys(normalised) });
}

// 4 of 7 — terms_and_conditions. Array of strings (each a clause). Whole
// array replaces on save (the pane owns the full list — there's no
// per-item identity, so partial-merge has no meaning).
async function handleSettingsConfigTerms(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const tc = body.terms_and_conditions;
  if (!Array.isArray(tc)) return json({ ok: false, error: 'terms_must_be_array' }, 400);
  if (tc.length > 200) return json({ ok: false, error: 'too_many_clauses', max: 200 }, 400);

  const cleaned = [];
  for (const [i, item] of tc.entries()) {
    if (typeof item !== 'string') return json({ ok: false, error: `clause_${i}_not_string` }, 400);
    if (item.length > 5000) return json({ ok: false, error: `clause_${i}_too_long`, max: 5000 }, 400);
    cleaned.push(item);
  }

  const ok = await mutateClientRecord(uuid, env, (record) => {
    record.terms_and_conditions = cleaned;
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, count: cleaned.length });
}

// 5 of 7 — credentials. Array of { name, detail } objects. Whole-array
// replace (same reasoning as terms — no per-item identity yet).
async function handleSettingsConfigCredentials(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const cr = body.credentials;
  if (!Array.isArray(cr)) return json({ ok: false, error: 'credentials_must_be_array' }, 400);
  if (cr.length > 50) return json({ ok: false, error: 'too_many_credentials', max: 50 }, 400);

  const cleaned = [];
  for (const [i, item] of cr.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return json({ ok: false, error: `credential_${i}_must_be_object` }, 400);
    }
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const detail = typeof item.detail === 'string' ? item.detail.trim() : '';
    if (!name && !detail) continue; // drop fully-empty rows
    if (name.length > 200 || detail.length > 1000) {
      return json({ ok: false, error: `credential_${i}_too_long` }, 400);
    }
    cleaned.push({ name, detail });
  }

  const ok = await mutateClientRecord(uuid, env, (record) => {
    record.credentials = cleaned;
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, count: cleaned.length });
}

// 6 of 7 — email_template. Single HTML string. Whole-field replace.
async function handleSettingsConfigEmailTemplate(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const tpl = body.email_template;
  if (tpl === undefined) return json({ ok: false, error: 'missing_email_template' }, 400);
  if (tpl !== null && typeof tpl !== 'string') return json({ ok: false, error: 'email_template_not_string' }, 400);
  const value = tpl == null ? '' : tpl;
  if (value.length > 50000) return json({ ok: false, error: 'email_template_too_long', max: 50000 }, 400);

  const ok = await mutateClientRecord(uuid, env, (record) => {
    record.email_template = value;
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, length: value.length });
}

// 7 of 7 — branding. Shape mirrors workers/pdf/index.js:27-35 resolveBranding:
//   { primary, accent, background, preset, heading_font, body_font }
// heading_font / body_font are reserved (ignored in v1 — Playfair/Mulish fixed).
// Hex strings validated against /^#[0-9a-f]{6}$/i; preset must be a known
// PRESETS key. Deep-merge per sub-key; null clears, undefined preserves.
const BRANDING_HEX_KEYS = new Set(['primary', 'accent', 'background']);
const BRANDING_OTHER_KEYS = new Set(['preset', 'heading_font', 'body_font']);
const BRANDING_ALL_KEYS = new Set([...BRANDING_HEX_KEYS, ...BRANDING_OTHER_KEYS]);
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/i;

async function handleSettingsConfigBranding(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  const br = body.branding;
  if (br === undefined) return json({ ok: false, error: 'missing_branding' }, 400);
  if (br === null) {
    // Explicit clear — reset to platform default fallthrough
    const ok = await mutateClientRecord(uuid, env, (record) => { record.branding = null; });
    if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
    return json({ ok: true, branding: null });
  }
  if (typeof br !== 'object' || Array.isArray(br)) {
    return json({ ok: false, error: 'branding_must_be_object_or_null' }, 400);
  }

  // Resolve known preset names from the pdf worker so the validator and the
  // renderer never disagree on what counts as a valid preset.
  let validPresets;
  try {
    if (!env.PDF_WORKER) throw new Error('pdf_worker_binding_missing');
    const res = await env.PDF_WORKER.fetch('https://internal/presets');
    if (!res.ok) throw new Error(`pdf_presets_${res.status}`);
    const data = await res.json();
    validPresets = new Set(Array.isArray(data.preset_names) ? data.preset_names : Object.keys(data.presets || {}));
  } catch (e) {
    return json({ ok: false, error: 'preset_validation_unavailable', detail: e.message }, 502);
  }

  const updates = {};
  const errors = [];
  for (const [k, v] of Object.entries(br)) {
    if (!BRANDING_ALL_KEYS.has(k)) { errors.push(`unknown_branding_key:${k}`); continue; }
    if (v === null) { updates[k] = null; continue; }
    if (typeof v !== 'string') { errors.push(`${k}_not_string`); continue; }
    if (BRANDING_HEX_KEYS.has(k) && !HEX_COLOUR_RE.test(v)) { errors.push(`${k}_not_hex_colour`); continue; }
    if (k === 'preset' && !validPresets.has(v)) { errors.push(`unknown_preset:${v}`); continue; }
    if (v.length > 100) { errors.push(`${k}_too_long`); continue; }
    updates[k] = v;
  }
  if (errors.length) return json({ ok: false, error: 'invalid_branding', errors }, 400);

  const ok = await mutateClientRecord(uuid, env, (record) => {
    const existing = (record.branding && typeof record.branding === 'object') ? record.branding : {};
    // Apply updates: null clears, value sets. Drop null entries from the
    // final object so resolveBranding's `b.primary || preset.primary` chain
    // falls through cleanly.
    const merged = { ...existing };
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    record.branding = Object.keys(merged).length ? merged : null;
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, keys: Object.keys(updates) });
}

// RFT-67 — per-tenant quote_title_format. Single scalar string. The pdf
// worker substitutes merge tags ({type}, {customer}, {client_name}, {street},
// {suburb}, {ref}, {date}) when rendering the PDF cover. Empty string OR
// null clears the override — buildJobTitle then falls back to the platform
// default ("{type} — {street}, {suburb}"). Max length capped low so the
// cover stays legible; the renderer also collapses double-separators when
// any tag substitutes to "".
async function handleSettingsConfigQuoteTitle(uuid, request, env) {
  const body = await parseBody(request);
  if (!body) return json({ ok: false, error: 'invalid_json' }, 400);
  const reject = rejectForbiddenConfigKeys(body);
  if (reject) return reject;

  if (body.quote_title_format === undefined) {
    return json({ ok: false, error: 'missing_quote_title_format' }, 400);
  }
  const { fields, errors } = pickStringFields(body, ['quote_title_format'], { maxLen: 200 });
  if (errors.length) return json({ ok: false, error: 'invalid_quote_title_format', errors }, 400);

  const ok = await mutateClientRecord(uuid, env, (record) => {
    record.quote_title_format = fields.quote_title_format || '';
  });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, quote_title_format: fields.quote_title_format });
}

// GET /settings/branding-presets — proxies the pdf worker's PRESETS table
// via the existing PDF_WORKER service binding (admin-api/wrangler.toml:23-25,
// constraint #11). NEVER inline-mirror the preset list in settings.html —
// swatch-vs-rendered-PDF drift is the worst branding failure mode.
async function handleSettingsBrandingPresets(env) {
  if (!env.PDF_WORKER) {
    return json({ ok: false, error: 'pdf_worker_binding_missing' }, 500);
  }
  try {
    const res = await env.PDF_WORKER.fetch('https://internal/presets');
    if (!res.ok) return json({ ok: false, error: `pdf_presets_${res.status}` }, 502);
    const data = await res.json();
    return json({ ok: true, ...data });
  } catch (e) {
    return json({ ok: false, error: 'pdf_presets_fetch_failed', detail: e.message }, 502);
  }
}

// ── Team access pane (RFT-87 scope b) ────────────────────────────────────────
//
// Three endpoints back the Team Access pane on /settings:
//   GET  /settings/team                  → members + pending invites + SM8 staff roster
//   POST /settings/team/invites          → create invite, suppress Clerk email, send our own
//   POST /settings/team/invites/revoke   → revoke a pending invite
//
// All three are admin-gated by settingsAdminGate at the dispatcher. The org
// scoping (clerk_org → uuid) is already done by handleSettings before we get
// here — `uuid` and `extractOrgId(jwtPayload)` are both trusted.
//
// Why notify=false: the user must land on a custom-flow page served from
// rafter.deepgreensea.au so the resulting passkey's RP ID = rafter.deepgreensea.au.
// Clerk's default invite email sends users through a *.clerk.accounts.dev page
// first — wrong origin for the passkey. Setting notify=false makes us the
// sender, and our email points directly at the `redirect_url` we configured.

async function handleSettingsTeam(uuid, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
  if (!env.CLERK_SECRET_KEY) return json({ ok: false, error: 'clerk_secret_key_missing' }, 500);

  // Members + pending invites from Clerk Backend API. Staff roster from
  // materials-sync (SM8 source of truth). All three in parallel.
  const [membersRes, invitesRes, staffRes] = await Promise.all([
    clerkBackendFetch(env, `/v1/organizations/${orgId}/memberships?limit=100`),
    clerkBackendFetch(env, `/v1/organizations/${orgId}/invitations?status=pending&limit=100`),
    syncFetch(env, `/sm8-staff?uuid=${uuid}`),
  ]);

  if (!membersRes.ok) return json({ ok: false, error: `clerk_memberships_${membersRes.status}` }, 502);
  if (!invitesRes.ok) return json({ ok: false, error: `clerk_invitations_${invitesRes.status}` }, 502);

  const membersBody = await membersRes.json();
  const invitesBody = await invitesRes.json();

  const members = (membersBody.data || []).map(m => ({
    id: m.id,
    user_id: m.public_user_data?.user_id || null,
    email: m.public_user_data?.identifier || '',
    first_name: m.public_user_data?.first_name || '',
    last_name: m.public_user_data?.last_name || '',
    role: m.role || '',
    created_at: m.created_at || null,
  }));

  const pending_invites = (invitesBody.data || []).map(i => ({
    id: i.id,
    email: i.email_address || '',
    role: i.role || '',
    created_at: i.created_at || null,
    // Staff attribution carried via public_metadata; surfaced so the UI can
    // show "Andy (Tradesperson)" next to a pending invite even before accept.
    staff_uuid: i.public_metadata?.staff_uuid || null,
    first: i.public_metadata?.first || '',
    last: i.public_metadata?.last || '',
  }));

  // Staff roster: empty array if SM8 not connected (no OAuth) or call failed.
  // Graceful — pane still shows members + pending invites, just no picker.
  let staff = [];
  let staff_error = null;
  if (staffRes.ok) {
    try {
      const body = await staffRes.json();
      staff = Array.isArray(body.staff) ? body.staff : [];
    } catch {
      staff_error = 'sm8_staff_invalid_json';
    }
  } else {
    staff_error = `sm8_staff_${staffRes.status}`;
  }

  return json({ ok: true, members, pending_invites, staff, staff_error });
}

async function handleSettingsTeamInviteSend(uuid, request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  const inviterUserId = jwtPayload.sub || null;
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
  if (!inviterUserId) return json({ ok: false, error: 'no_user_in_jwt' }, 401);
  if (!env.CLERK_SECRET_KEY) return json({ ok: false, error: 'clerk_secret_key_missing' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const staff_uuid = typeof body?.staff_uuid === 'string' ? body.staff_uuid.trim() : '';
  const first = typeof body?.first === 'string' ? body.first.trim().slice(0, 80) : '';
  const last = typeof body?.last === 'string' ? body.last.trim().slice(0, 80) : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }

  // Slug needed for the redirect_url so accept-invite.html knows which tenant
  // to land on after enrolment. Pull from the tenant record — we already
  // resolved uuid from the JWT org, so this is the trusted slug for the org.
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'client_not_found' }, 404);
  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }
  const slug = record.slug || '';
  if (!slug) return json({ ok: false, error: 'tenant_slug_missing' }, 400);
  const companyName = record.company_name || 'Rafter';

  // Admin inviter email — used in the email body so the recipient sees who
  // sent the invitation. Pull from membership data we already have.
  const adminEmail = await lookupInviterEmail(env, orgId, inviterUserId).catch(() => '');

  // RFT-87 scope (b) FIX 1 (2026-06-11): encode the target org_id in the
  // redirect_url. The frontend SignUp resource does NOT expose organizationId
  // post-ticket-accept (verified against clerk/javascript SignUp.ts — no org
  // field), and the User resource has no "last accepted invitation" or
  // "current organization" field either. Sorting organizationMemberships by
  // createdAt and picking the freshest is correct for the sign_up case
  // (single membership) but unsafe for the sign_in case where an existing
  // user with multiple org memberships accepts a fresh ticket. Server-side
  // is the only place that authoritatively knows which org this ticket is
  // for at invite-create time — encode it here, read it on the accept page.
  const redirectUrl = `https://rafter.deepgreensea.au/accept-invite.html?slug=${encodeURIComponent(slug)}&org=${encodeURIComponent(orgId)}`;

  // Create the Clerk invitation with notify=false (suppresses Clerk's email,
  // returns the ticket URL on the response so we can send it ourselves).
  const inviteRes = await clerkBackendFetch(env, `/v1/organizations/${orgId}/invitations`, {
    method: 'POST',
    body: JSON.stringify({
      email_address: email,
      role: 'org:member', // Passkey-on-invite default — no admin power for invitees
      redirect_url: redirectUrl,
      inviter_user_id: inviterUserId,
      notify: false,
      public_metadata: { staff_uuid: staff_uuid || null, first, last },
    }),
  });

  if (!inviteRes.ok) {
    let detail = '';
    try { detail = await inviteRes.text(); } catch {}
    return json({ ok: false, error: 'clerk_invite_failed', status: inviteRes.status, detail: detail.slice(0, 500) }, 502);
  }

  const inviteBody = await inviteRes.json();
  const inviteUrl = inviteBody.url || null;
  const inviteId = inviteBody.id || null;
  if (!inviteUrl) {
    return json({ ok: false, error: 'invite_url_missing', invitation_id: inviteId }, 502);
  }

  // Send the Rafter-owned invite email. If the send fails, the invitation
  // still exists in Clerk — admin can re-send manually using the returned
  // invitation_id. Return partial success so the UI can surface the URL.
  let email_sent = false;
  let email_error = null;
  try {
    await sendInviteEmail(env, {
      toEmail: email,
      toName: [first, last].filter(Boolean).join(' '),
      inviteUrl,
      companyName,
      adminEmail,
    });
    email_sent = true;
  } catch (e) {
    email_error = e.message || 'email_send_failed';
    console.error(JSON.stringify({ event: 'invite_email_send_failed', uuid, invitation_id: inviteId, error: email_error }));
  }

  return json({
    ok: true,
    invitation_id: inviteId,
    email,
    email_sent,
    email_error,
    // Returned even on success so an admin can copy the URL into a different
    // channel (SMS, in-person etc.) if needed. Future: don't return when
    // we add a Rafter-owned SMS path.
    invite_url: inviteUrl,
  });
}

async function handleSettingsTeamInviteRevoke(uuid, request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  const requesterUserId = jwtPayload.sub || null;
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
  if (!requesterUserId) return json({ ok: false, error: 'no_user_in_jwt' }, 401);
  if (!env.CLERK_SECRET_KEY) return json({ ok: false, error: 'clerk_secret_key_missing' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const invitation_id = typeof body?.invitation_id === 'string' ? body.invitation_id.trim() : '';
  if (!invitation_id || !/^[a-z0-9_-]+$/i.test(invitation_id)) {
    return json({ ok: false, error: 'invalid_invitation_id' }, 400);
  }

  const res = await clerkBackendFetch(env, `/v1/organizations/${orgId}/invitations/${invitation_id}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ requesting_user_id: requesterUserId }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    return json({ ok: false, error: 'clerk_revoke_failed', status: res.status, detail: detail.slice(0, 500) }, 502);
  }
  return json({ ok: true, invitation_id });
}

// RFT-111: revoke an active member's org membership. Org-scoped — Clerk user
// stays intact (they may belong to other Rafter tenants). Two server-side
// guards: can't remove yourself, can't remove the only admin.
async function handleSettingsTeamMemberRemove(uuid, request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  const requesterUserId = jwtPayload.sub || null;
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);
  if (!requesterUserId) return json({ ok: false, error: 'no_user_in_jwt' }, 401);
  if (!env.CLERK_SECRET_KEY) return json({ ok: false, error: 'clerk_secret_key_missing' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }

  const user_id = typeof body?.user_id === 'string' ? body.user_id.trim() : '';
  if (!user_id || !/^user_[A-Za-z0-9]+$/.test(user_id)) {
    return json({ ok: false, error: 'invalid_user_id' }, 400);
  }

  // Guard 1: self-removal would brick the admin (no other admin to re-invite).
  if (user_id === requesterUserId) {
    return json({ ok: false, error: 'cannot_remove_self' }, 400);
  }

  // Guard 2: last-admin check. Clerk Backend API may return role as 'admin' or
  // 'org:admin' depending on instance shape — match both.
  const isAdminRole = (r) => r === 'admin' || r === 'org:admin';
  const memberships = await clerkBackendFetch(env, `/v1/organizations/${orgId}/memberships?limit=100`);
  if (!memberships.ok) {
    let detail = '';
    try { detail = await memberships.text(); } catch {}
    return json({ ok: false, error: 'clerk_memberships_failed', status: memberships.status, detail: detail.slice(0, 500) }, 502);
  }
  const membersBody = await memberships.json();
  const data = membersBody.data || [];
  const targetIsAdmin = data.some(m => m.public_user_data?.user_id === user_id && isAdminRole(m.role));
  if (targetIsAdmin) {
    const adminCount = data.filter(m => isAdminRole(m.role)).length;
    if (adminCount <= 1) {
      return json({ ok: false, error: 'last_admin_removal_blocked' }, 400);
    }
  }

  const res = await clerkBackendFetch(env, `/v1/organizations/${orgId}/memberships/${user_id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch {}
    return json({ ok: false, error: 'clerk_remove_failed', status: res.status, detail: detail.slice(0, 500) }, 502);
  }
  return json({ ok: true, user_id, removed_from_org: orgId });
}

// Look up the inviter's email from the organization memberships. Used to
// populate "invited by ..." in the recipient's email. Best-effort — empty
// string fallback so a missing membership doesn't block the invite.
async function lookupInviterEmail(env, orgId, userId) {
  const res = await clerkBackendFetch(env, `/v1/organizations/${orgId}/memberships?limit=100`);
  if (!res.ok) return '';
  const body = await res.json().catch(() => ({}));
  const match = (body.data || []).find(m => m.public_user_data?.user_id === userId);
  return match?.public_user_data?.identifier || '';
}

// Thin Clerk Backend API wrapper. Centralises the secret-key auth header so
// callers only think about path + body. CLERK_SECRET_KEY is set as a worker
// secret — never logged, never sent to the browser.
function clerkBackendFetch(env, path, init = {}) {
  return fetch(`https://api.clerk.com${path}`, {
    method: init.method || 'GET',
    headers: {
      'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    body: init.body,
  });
}

// Rafter-owned invite email send. Uses Cloudflare Email Sending via the
// SEND_EMAIL binding (admin-api/wrangler.toml). From-address is read from
// the INVITE_FROM_ADDRESS env var (defaults to invites@deepgreensea.au).
// The from-domain MUST be verified in Cloudflare Email Routing for the
// destination's DKIM check to pass — see prod-instance checklist.
async function sendInviteEmail(env, { toEmail, toName, inviteUrl, companyName, adminEmail }) {
  if (!env.SEND_EMAIL) throw new Error('send_email_binding_missing');
  const fromAddr = env.INVITE_FROM_ADDRESS || 'invites@deepgreensea.au';
  const fromName = `${companyName} via Rafter`;
  const subject = `${companyName} — set up your sign-in`;
  const html = renderInviteHtml({ companyName, inviteUrl, adminEmail, recipientName: toName });
  const text = renderInviteText({ companyName, inviteUrl, adminEmail, recipientName: toName });
  const raw = buildMimeMessage({ fromName, fromAddr, toEmail, subject, html, text });

  const { EmailMessage } = await import('cloudflare:email');
  const message = new EmailMessage(fromAddr, toEmail, raw);
  await env.SEND_EMAIL.send(message);
}

function renderInviteHtml({ companyName, inviteUrl, adminEmail, recipientName }) {
  const safeName = (recipientName || '').replace(/[<>&"]/g, '');
  const greeting = safeName ? `Hi ${safeName},` : 'Hi,';
  const adminLine = adminEmail
    ? `This invitation was sent by ${adminEmail.replace(/[<>&"]/g, '')}. If you weren't expecting it, you can ignore this email.`
    : "If you weren't expecting this invitation, you can ignore this email.";
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1C1C1C;line-height:1.5;margin:0;padding:24px;background:#F7F9FC;">
<div style="max-width:540px;margin:0 auto;">
  <div style="background:#1B4F72;color:#fff;padding:18px 24px;border-radius:10px 10px 0 0;font-size:16px;font-weight:600;">${companyName.replace(/[<>&"]/g, '')}</div>
  <div style="background:#fff;border:1px solid #D4D0C8;border-top:0;padding:24px;border-radius:0 0 10px 10px;">
    <p style="margin:0 0 12px;">${greeting}</p>
    <p style="margin:0 0 12px;">${companyName.replace(/[<>&"]/g, '')} uses Rafter to send quotes from the field. You've been invited to set up your sign-in.</p>
    <p style="margin:0 0 12px;">Tap the button below on the device you'll use for quoting. You'll set up a passkey (Face ID, fingerprint or device PIN) and be signed in for next time.</p>
    <p style="margin:24px 0;"><a href="${inviteUrl}" style="background:#1B4F72;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block;">Set up this device</a></p>
    <p style="font-size:12px;color:#6B7280;margin:0 0 12px;">If the button doesn't work, paste this link into your browser:<br><span style="word-break:break-all;">${inviteUrl}</span></p>
    <p style="font-size:12px;color:#6B7280;margin:24px 0 0;">${adminLine}</p>
  </div>
  <p style="font-size:11px;color:#9AA0A6;text-align:center;margin-top:16px;">Rafter · Built by Deep Green Sea</p>
</div>
</body></html>`;
}

function renderInviteText({ companyName, inviteUrl, adminEmail, recipientName }) {
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';
  const adminLine = adminEmail
    ? `This invitation was sent by ${adminEmail}. If you weren't expecting it, you can ignore this email.`
    : "If you weren't expecting this invitation, you can ignore this email.";
  return [
    companyName,
    '',
    greeting,
    '',
    `${companyName} uses Rafter to send quotes from the field. You've been invited to set up your sign-in.`,
    '',
    "Tap this link on the device you'll use for quoting. You'll set up a passkey (Face ID, fingerprint or device PIN) and be signed in for next time.",
    '',
    inviteUrl,
    '',
    adminLine,
    '',
    'Rafter — Built by Deep Green Sea',
  ].join('\r\n');
}

// Hand-rolled multipart/alternative MIME message. No npm dep — Workers can
// build the raw string directly. Boundary string is fresh per call. CRLF
// line endings are required by RFC 5322; Cloudflare Email Sending rejects
// LF-only messages.
function buildMimeMessage({ fromName, fromAddr, toEmail, subject, html, text }) {
  const boundary = `rfBoundary${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const fromHeader = fromName ? `${mimeEncodeWord(fromName)} <${fromAddr}>` : fromAddr;
  const lines = [
    `From: ${fromHeader}`,
    `To: ${toEmail}`,
    `Subject: ${mimeEncodeWord(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

// RFC 2047 encoded-word for non-ASCII subject/from-name. Conservative: only
// encode if there are non-ASCII chars. Base64 over UTF-8.
function mimeEncodeWord(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

// Clone a SM8 jobtemplate to a job, GET the job to read its prose, push
// the clone uuid onto the supplied tracking array so finally{} can soft-
// delete it. Throws on failure with a `.step` property attached so the
// caller can categorise the failure bucket.
async function cloneReadProse(token, tplUuid, createdJobUuids) {
  const cloneRes = await fetch(`${SM8_BASE}/jobtemplate/${tplUuid}/job.json`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!cloneRes.ok) { const e = new Error(`clone failed ${cloneRes.status}`); e.step = 'clone'; throw e; }
  let cloneBody;
  try { cloneBody = await cloneRes.json(); }
  catch { const e = new Error('clone body not json'); e.step = 'clone_body'; throw e; }
  // Docs gotcha: response uses jobUUID, not uuid (RFT-80 finding)
  const clonedUuid = cloneBody.jobUUID;
  if (!clonedUuid) { const e = new Error('clone response missing jobUUID'); e.step = 'clone_no_uuid'; throw e; }
  createdJobUuids.push(clonedUuid);

  const readRes = await fetch(`${SM8_BASE}/job/${clonedUuid}.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!readRes.ok) { const e = new Error(`read failed ${readRes.status}`); e.step = 'read'; throw e; }
  let jobRecord;
  try { jobRecord = await readRes.json(); }
  catch { const e = new Error('read body not json'); e.step = 'read_body'; throw e; }
  // Empty prose is valid (e.g. Miscellaneous template) — store empty
  return typeof jobRecord.job_description === 'string' ? jobRecord.job_description : '';
}

// List all R2 object keys under a prefix, paginating until done. Cap at
// 50 pages × 1000/page = 50k objects per slug — well above the practical
// tenant ceiling.
async function listR2KeysUnder(env, prefix) {
  const keys = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const opts = cursor ? { prefix, cursor } : { prefix };
    const page = await env.RAFTER_ASSETS.list(opts);
    for (const obj of page.objects) keys.push(obj.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return keys;
}

// ── SM8 OAuth callback (RFT-69 Path 2 — removes Make from the auth path) ────

async function handleSm8Callback(request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'No org_id in JWT' }, 401);

  // RFT-70 Option C D1 — connect is admin-only. A member completing OAuth
  // would silently replace the org's single SM8 grant, which is exactly the
  // multi-user footgun Option C exists to eliminate. Start strict; loosen later
  // only if the friction is real.
  const orgRole = extractOrgRole(jwtPayload);
  if (orgRole !== 'org:admin') {
    return json({
      ok: false,
      error: 'role_forbidden',
      code: 'NOT_ADMIN',
      detail: 'Only the organisation admin can connect ServiceM8. Ask your org admin to connect, then you can use the form as a member.',
      org_role: orgRole,
    }, 403);
  }

  const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!uuid) return json({ ok: false, error: 'Client not provisioned — Clerk org webhook may not have fired' }, 404);

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Invalid JSON body' }, 400); }

  const code = body?.code;
  if (!code || typeof code !== 'string') return json({ ok: false, error: 'missing_code' }, 400);

  if (!env.SERVICEM8_CLIENT_SECRET) {
    return json({ ok: false, error: 'server_misconfigured', detail: 'SERVICEM8_CLIENT_SECRET not set' }, 500);
  }
  if (!env.RAFTER_WORKER_SECRET) {
    return json({ ok: false, error: 'server_misconfigured', detail: 'RAFTER_WORKER_SECRET not set' }, 500);
  }

  // RFT-70 Option C D3 — race lock around the establish critical section.
  // Loser of a concurrent establish gets a clear 409 retry response, NEVER a
  // silent drop (a silent drop would reintroduce the exact bug Option C kills).
  const userId = jwtPayload.sub || null;
  const lock = await acquireConnectLock(env, uuid, userId);
  if (!lock.ok) {
    return json({
      ok: false,
      error: 'another_connection_in_progress',
      code: 'CONNECT_IN_PROGRESS',
      detail: 'Another admin started a ServiceM8 connection moments ago. Wait a few seconds and try again.',
      started_by_user_id: lock.held_by_user_id,
      started_at: lock.started_at,
      retry_after_seconds: CONNECT_LOCK_TTL_SECONDS,
    }, 409);
  }

  try {
    // Code → tokens via SM8 directly. client_id 781230 is the registered OAuth
    // app bound to rafter.deepgreensea.au/callback (RFT-69 Decision 2 — SM8
    // admin confirmed single registered app). Matches setup.html:311 +
    // materials-sync SM8_CLIENT_ID.
    const tokenRes = await fetch('https://go.servicem8.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: '781230',
        client_secret: env.SERVICEM8_CLIENT_SECRET,
        redirect_uri: 'https://rafter.deepgreensea.au/callback',
      }).toString(),
    });

    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      return json({ ok: false, error: 'sm8_token_exchange_failed', status: tokenRes.status, detail: detail.slice(0, 500) }, 502);
    }

    let tokens;
    try { tokens = await tokenRes.json(); }
    catch (e) { return json({ ok: false, error: 'sm8_token_exchange_invalid_response', detail: e.message }, 502); }

    if (!tokens.access_token) {
      return json({ ok: false, error: 'sm8_token_exchange_no_access_token' }, 502);
    }

    const expires_at = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : null;

    // Persist via materials-sync /store-token through the service binding.
    // The URL host is irrelevant on a service binding — only the path matters.
    // RFT-70 Option C D2 — pass connected_by_user_id so materials-sync writes
    // connected_by_user_id + connected_at on this establish, regardless of
    // whether it's first-establish or a takeover.
    const storeRes = await env.MATERIALS_SYNC_WORKER.fetch('https://internal/store-token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RAFTER_WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        uuid,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at,
        connected_by_user_id: userId,
      }),
    });

    if (!storeRes.ok) {
      const detail = await storeRes.text().catch(() => '');
      return json({ ok: false, error: 'store_token_failed', status: storeRes.status, detail: detail.slice(0, 500) }, 502);
    }

    let storeBody = null;
    try { storeBody = await storeRes.json(); } catch { /* ignore */ }
    const wasTakeover = !!storeBody?.is_takeover;
    const wasConnected = !!storeBody?.was_connected;
    const previousConnectedBy = storeBody?.previous_connected_by_user_id ?? null;

    // Single structured log line carries the takeover signal even before the
    // audit/dashboard layer ships (deferred until RFT-83 is closed). Field
    // names are stable so future ingest can rely on them.
    console.log(JSON.stringify({
      event: wasTakeover ? 'sm8_connection_takeover' : (wasConnected ? 'sm8_connection_reconnected' : 'sm8_connection_established'),
      uuid,
      connected_by_user_id: userId,
      previous_connected_by_user_id: previousConnectedBy,
    }));

    return json({
      ok: true,
      uuid,
      was_connected: wasConnected,
      is_takeover: wasTakeover,
      previous_connected_by_user_id: previousConnectedBy,
    });
  } finally {
    await releaseConnectLock(env, uuid).catch(() => {});
  }
}

// ── RFT-70 Option C — SM8 disconnect (admin-only) ────────────────────────────
// Clears the org's SM8 grant from KV so a fresh OAuth can land cleanly. The
// client record itself stays (org + business config persist); only the
// connection-related fields are removed. Operator reconnects via setup.html.
// UI surface deferred to RFT-63 (tenant config). This endpoint is the JSON
// stub the UI will call.
async function handleSm8Disconnect(request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'No org_id in JWT' }, 401);

  // D1 — same gate as connect. Member can't disconnect; that's the whole point.
  const orgRole = extractOrgRole(jwtPayload);
  if (orgRole !== 'org:admin') {
    return json({
      ok: false,
      error: 'role_forbidden',
      code: 'NOT_ADMIN',
      detail: 'Only the organisation admin can disconnect ServiceM8. Ask your org admin.',
      org_role: orgRole,
    }, 403);
  }

  const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!uuid) return json({ ok: false, error: 'Client not provisioned' }, 404);

  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'Client record not found' }, 404);

  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'Client record corrupt' }, 500); }

  const wasConnected = !!record.access_token;
  const previousConnectedBy = record.connected_by_user_id || null;

  delete record.access_token;
  delete record.refresh_token;
  delete record.expires_at;
  delete record.token_updated_at;
  delete record.connected_by_user_id;
  delete record.connected_at;

  await env.RAFTER_CLIENTS.put(CLIENT_PREFIX + uuid, JSON.stringify(record));

  console.log(JSON.stringify({
    event: 'sm8_connection_disconnected',
    uuid,
    disconnected_by_user_id: jwtPayload.sub || null,
    previous_connected_by_user_id: previousConnectedBy,
    was_connected: wasConnected,
  }));

  return json({
    ok: true,
    uuid,
    was_connected: wasConnected,
    previous_connected_by_user_id: previousConnectedBy,
  });
}

// ── Photo upload ─────────────────────────────────────────────────────────────

async function handleOnboardingPhotos(request, env, jwtPayload) {
  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'No org_id in JWT' }, 401);

  const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!uuid) return json({ ok: false, error: 'Client not provisioned — complete Step 3 first' }, 404);

  let formData;
  try { formData = await request.formData(); } catch {
    return json({ ok: false, error: 'Invalid multipart body' }, 400);
  }

  const file     = formData.get('file');
  const category = formData.get('category');

  if (!file || typeof file === 'string') return json({ ok: false, error: 'missing_file' }, 400);
  if (!category)                         return json({ ok: false, error: 'missing_category' }, 400);

  const safeCategory = sanitisePathSegment(category);
  const safeFilename = makePhotoFilename(file.name || 'photo');
  const key = `clients/${uuid}/photos/${safeCategory}/${safeFilename}`;

  const buffer = await file.arrayBuffer();
  await env.RAFTER_ASSETS.put(key, buffer, { httpMetadata: { contentType: 'image/jpeg' } });

  console.log(JSON.stringify({ event: 'photo_uploaded', uuid, key }));
  return json({ ok: true, key });
}

function sanitisePathSegment(s) {
  return (s ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'general';
}

function makePhotoFilename(originalName) {
  const base = originalName.replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 30) || 'photo';
  const id = Math.random().toString(36).slice(2, 8);
  return `${base}-${id}.jpg`;
}

// ── Provisioning — REQ-On-29 to 34 ──────────────────────────────────────────

async function handleProvision(body, env) {
  const errors = [];
  if (!body.slug) {
    errors.push('slug required');
  } else {
    // RFT-110: normalise + validate before any KV write.
    body.slug = String(body.slug).trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(body.slug)) {
      errors.push('slug must be lowercase letters, digits, and hyphens only');
    }
  }
  if (!body.company_name) errors.push('company_name required');
  if (body.webhook_url !== undefined) errors.push('webhook_url not allowed — send webhook_env');
  if (!body.webhook_env) errors.push('webhook_env required');
  else if (!['prod', 'dev'].includes(body.webhook_env)) errors.push('webhook_env must be "prod" or "dev"');
  if (errors.length) return json({ ok: false, errors }, 400);

  // RFT-58: resolve Make webhook URL from secret, server-side. URL never enters
  // client code or KV via untrusted input.
  const envKey = body.webhook_env === 'prod' ? 'MAKE_WEBHOOK_PROD' : 'MAKE_WEBHOOK_DEV';
  const resolved = env[envKey];
  if (!resolved) {
    return json({ ok: false, error: 'server_misconfigured', detail: `${envKey} not set` }, 500);
  }
  body.webhook_url = resolved;

  try {
    const result = await provisionClient(body, env);
    return json({ ok: true, ...result });
  } catch (err) {
    if (err.code === 'SLUG_TAKEN') {
      return json({ ok: false, error: err.message, code: 'SLUG_TAKEN' }, 409);
    }
    console.error(JSON.stringify({ event: 'provision_error', error: err.message }));
    return json({ ok: false, error: err.message }, 500);
  }
}

// RFT-125 — single source of truth for the Rafter-managed Miscellaneous
// template shape. Used by provisionClient (first-time onboarding) and
// handleSettingsSectionsSync (auto-injected when SM8 returns 0 and the
// tenant has nothing). `source: "rafter"` is the load-bearing flag —
// sections.sync filters these out of the SM8-mirror toRemove list so they
// survive every sync regardless of what SM8 says.
function DEFAULT_MISC_TEMPLATE() {
  return {
    name: 'Miscellaneous',
    text: '',
    sm8_template_uuid: null,
    source: 'rafter',
  };
}

async function provisionClient(body, env) {
  // UUID resolution: explicit → clerk_org reverse lookup → new random
  // Clerk_org lookup ensures webhook stub + form submission share the same UUID (REQ-On-13 merge-safe)
  let uuid = body.uuid;
  if (!uuid && body.clerk_org_id) {
    uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + body.clerk_org_id).catch(() => null);
  }
  uuid = uuid || crypto.randomUUID();
  const { slug } = body;

  // Read existing for merge-safe update — preserves all fields (incl. OAuth tokens) not in body
  const existingRaw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  // Defaults for fields that must exist even on a fresh record
  const defaults = {
    phone: '', business_address: '', abn: '', business_email: '', operator_email: '',
    payment_thresholds: {}, proposal_types: [], job_categories: [], job_queues: [],
    templates: [], credentials: [], terms_and_conditions: [], staff_uuid: '',
    email_template: '', bank_details: {}, clerk_org_id: null, branding: null,
  };

  // REQ-On-29: build record — defaults → existing (preserves OAuth tokens etc.) → required body fields
  const record = { ...defaults, ...existing, uuid, slug, company_name: body.company_name, webhook_url: body.webhook_url, logo_url: `${MATERIALS_SYNC}/logo/${uuid}` };

  // Optional fields: only override if explicitly provided in body
  const OPTIONAL_FIELDS = ['phone','business_address','abn','business_email','operator_email',
    'payment_thresholds','proposal_types','job_categories','job_queues','templates',
    'credentials','terms_and_conditions','staff_uuid','email_template','bank_details','clerk_org_id','branding'];
  for (const f of OPTIONAL_FIELDS) {
    if (body[f] !== undefined) record[f] = body[f];
  }

  // Normalise payment_thresholds: onboarding form sends arrays [50,50] → store as "50/50" strings
  // index.html parseSplit() calls .split("/") so KV must hold slash-delimited strings, not arrays.
  if (record.payment_thresholds && typeof record.payment_thresholds === 'object') {
    const normalised = {};
    for (const [k, v] of Object.entries(record.payment_thresholds)) {
      normalised[k] = Array.isArray(v) ? v.join('/') : v;
    }
    record.payment_thresholds = normalised;
  }

  // RFT-125 — auto-Miscellaneous for empty-template tenants. If the new record
  // has zero templates (typical pre-SM8-sync state) inject a Rafter-managed
  // Miscellaneous section so the form picker + photo picker have at least
  // one bucket from day one. `source: "rafter"` marks it as outside the D11
  // SM8 mirror — handleSettingsSectionsSync preserves these during sync.
  if (!Array.isArray(record.templates) || record.templates.length === 0) {
    record.templates = [DEFAULT_MISC_TEMPLATE()];
  }

  // REQ-On-29: uniqueness guard before any write — fail fast so no partial state is left
  if (slug) {
    const slugOwner = await env.RAFTER_CLIENTS.get(SLUG_PREFIX + slug);
    if (slugOwner && slugOwner !== uuid) {
      const err = new Error(`slug '${slug}' is already taken — choose a different URL identifier`);
      err.code = 'SLUG_TAKEN';
      throw err;
    }
  }

  // Write KV client record + slug resolver
  await env.RAFTER_CLIENTS.put(CLIENT_PREFIX + uuid, JSON.stringify(record));
  if (slug) await env.RAFTER_CLIENTS.put(SLUG_PREFIX + slug, uuid);
  // Clerk org reverse index: enables UUID continuity and idempotency checks
  if (record.clerk_org_id) await env.RAFTER_CLIENTS.put('clerk_org:' + record.clerk_org_id, uuid);
  // Clean up stale slug key if slug changed (e.g., Clerk slug replaced by admin slug on form submit)
  if (existing.slug && slug && existing.slug !== slug) {
    await env.RAFTER_CLIENTS.delete(SLUG_PREFIX + existing.slug).catch(() => {});
  }

  // Auto-generate email_template if not supplied — embeds the correct logo URL (requires uuid to be finalised)
  if (!record.email_template) {
    const co    = record.company_name || 'Your company';
    const phone = record.phone ? `<br>${record.phone}` : '';
    record.email_template =
      `<img src="${MATERIALS_SYNC}/logo/${uuid}" alt="${co.replace(/"/g, '&quot;')}" style="max-width:200px;height:auto;display:block;margin-bottom:20px;">\n` +
      `<p>Hi {client_name},</p>\n\n` +
      `<p>Please find attached your quote for the work at {job_address}.</p>\n\n` +
      `<p>To accept this quote, simply reply to this email or give us a call and we'll confirm the schedule and get started.</p>\n\n` +
      `<p>If you have any questions about the quote, we're happy to talk through them.</p>\n\n` +
      `<p>Thanks,<br>${co}${phone}</p>`;
  }

  // REQ-On-30: upload logo to R2 if provided as base64
  let logo_uploaded = false;
  if (body.logo_base64) {
    const bytes = base64ToBytes(body.logo_base64);
    await env.RAFTER_ASSETS.put(`clients/${uuid}/logo.png`, bytes, {
      httpMetadata: { contentType: body.logo_content_type ?? 'image/png' },
    });
    logo_uploaded = true;
  }

  // REQ-On-31: materials-sync Worker secrets must be provisioned on every deploy (out-of-band)

  // REQ-On-32: trigger materials sync
  let sync_ok = false;
  let sync_error = null;
  try {
    const res = await syncFetch(env, `/refresh-materials?uuid=${uuid}`);
    sync_ok = res.ok;
    if (!sync_ok) sync_error = await res.text().catch(() => String(res.status));
  } catch (err) {
    sync_error = err.message;
  }

  // REQ-On-33: write onboarding_started event to D1
  await writeEvent(env, 'onboarding_started', uuid, { slug, company_name: body.company_name });

  // REQ-On-34: provisioning gate 5b — KV readable, logo serves, slug resolves (pre-OAuth)
  const gate = await runProvisioningGate(uuid, slug, env);

  return { uuid, slug, logo_uploaded, sync_ok, sync_error, gate };
}

// REQ-On-34: provisioning gate (pre-OAuth checks only)
async function runProvisioningGate(uuid, slug, env) {
  const checks = {};

  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid);
  checks.kv_readable = !!raw;

  try {
    const obj = await env.RAFTER_ASSETS.get(`clients/${uuid}/logo.png`);
    checks.logo_serves = !!obj;
  } catch {
    checks.logo_serves = false;
  }

  const target = await env.RAFTER_CLIENTS.get(SLUG_PREFIX + slug);
  checks.slug_resolves = target === uuid;

  return { passed: Object.values(checks).every(Boolean), checks };
}

// ── List clients — REQ-On-27 ─────────────────────────────────────────────────

async function handleListClients(env) {
  // List all client: keys, return summary of each record
  const clients = [];
  let cursor;
  do {
    const page = await env.RAFTER_CLIENTS.list({ prefix: CLIENT_PREFIX, cursor });
    for (const key of page.keys) {
      const uuid = key.name.slice(CLIENT_PREFIX.length);
      if (!uuid) continue;
      const raw = await env.RAFTER_CLIENTS.get(key.name);
      if (!raw) continue;
      try {
        const record = JSON.parse(raw);
        const hasTokens = !!(record.access_token && record.refresh_token);
        const tokenExpiresAt = record.expires_at ?? null;
        const tokenExpired = tokenExpiresAt ? Date.now() >= new Date(tokenExpiresAt).getTime() : null;
        // stage: pending = webhook fired, operator not yet set slug/webhook_url via form
        //        provisioned = form submitted, full record present (may still fail smoketest)
        //        stub = manually created with missing data, no clerk_org_id link
        const stage = record.slug && record.webhook_url
          ? 'provisioned'
          : record.clerk_org_id
            ? 'pending'
            : 'stub';
        // kv_complete and missing_fields only meaningful for provisioned records — pending stubs
        // are intentionally incomplete and should not read as broken
        const missingFields = stage === 'provisioned' ? REQUIRED_FIELDS.filter(f => !record[f]) : [];
        clients.push({
          uuid,
          slug: record.slug ?? null,
          company_name: record.company_name ?? null,
          clerk_org_id: record.clerk_org_id ?? null,
          stage,
          has_tokens: hasTokens,
          token_expires_at: tokenExpiresAt,
          token_expired: tokenExpired,
          kv_complete: stage === 'provisioned' ? missingFields.length === 0 : null,
          missing_fields: missingFields.length ? missingFields : undefined,
        });
      } catch {
        clients.push({ uuid, error: 'parse_failed' });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, count: clients.length, clients });
}

// ── Sync handler — REQ-On-25 ─────────────────────────────────────────────────

async function handleSync(uuid, env) {
  try {
    const res = await syncFetch(env, `/refresh-materials?uuid=${uuid}`);
    const body = await res.json().catch(() => ({ status: res.status }));
    if (!res.ok) return json({ ok: false, error: 'sync failed', detail: body }, 502);
    await writeEvent(env, 'sync_completed', uuid, {});
    return json({ ok: true, synced: true, detail: body });
  } catch (err) {
    await writeEvent(env, 'sync_failed', uuid, { error: err.message });
    return json({ ok: false, error: err.message }, 500);
  }
}

// ── RFT-122: Platform operator console (/console/*) ─────────────────────────
//
// Cross-tenant admin surface. Platform operators see every tenant regardless
// of org membership; teardown deletes Clerk org + R2 + D1 + KV in one call.
//
// Endpoints (all gated by platformOperatorGate):
//   GET  /console/tenants                       — list, with Clerk + D1 aggregates
//   GET  /console/tenants/:uuid                 — single-tenant detail
//   POST /console/tenants/:uuid/teardown        — full nuke (prod requires confirm_slug)
//   POST /console/tenants/:uuid/environment     — set environment tag
//   POST /console/backfill-environment          — one-shot dev+bvt env field write

const CLERK_API_BASE = 'https://api.clerk.com';
const VALID_ENVIRONMENTS = new Set(['dev', 'bvt', 'prod']);

async function clerkFetch(env, path, init = {}) {
  if (!env.CLERK_SECRET_KEY) {
    return { ok: false, status: 503, error: 'clerk_secret_key_not_set' };
  }
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.CLERK_SECRET_KEY}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const res = await fetch(`${CLERK_API_BASE}${path}`, { ...init, headers });
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
    }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function handleConsole(request, env, url, jwtPayload, userId) {
  const { method } = request;
  const path = url.pathname;

  if (method === 'GET' && path === '/console/tenants') {
    return handleConsoleTenants(env);
  }
  if (method === 'POST' && path === '/console/backfill-environment') {
    return handleConsoleBackfillEnvironment(env);
  }
  if (method === 'GET' && path === '/console/observability') {
    return handleConsoleObservability(url, env);
  }
  if (method === 'GET' && path === '/console/observability/summary') {
    return handleConsoleObservabilitySummary(env);
  }
  if (method === 'GET' && path === '/console/team') {
    return handleConsoleTeam(env);
  }
  if (method === 'GET' && path === '/console/platform-health') {
    return handleConsolePlatformHealth(env);
  }
  if (method === 'GET' && path === '/console/issues') {
    return handleConsoleIssues(env);
  }
  if (method === 'GET' && path === '/console/make-scenarios') {
    return handleConsoleMakeScenarios(env);
  }
  if (method === 'GET' && path === '/console/cost-usage') {
    return handleConsoleCostUsage(env);
  }
  const tenantMatch = path.match(/^\/console\/tenants\/([0-9a-f-]{36})(\/[a-z-]+)?$/i);
  if (tenantMatch) {
    const [, uuid, action] = tenantMatch;
    if (method === 'GET' && !action) return handleConsoleTenantDetail(uuid, env);
    if (method === 'POST' && action === '/teardown') return handleConsoleTeardown(uuid, request, env, userId);
    if (method === 'POST' && action === '/environment') return handleConsoleSetEnvironment(uuid, request, env);
  }
  return json({ ok: false, error: 'console_route_not_found', path }, 404);
}

// GET /console/tenants — cross-tenant list with enrichment. KV scan is the
// authoritative source of tenants; Clerk + D1 lookups degrade gracefully (a
// per-tenant fetch failure returns null for that tenant's enriched fields,
// not a 500 for the whole list).
async function handleConsoleTenants(env) {
  const tenants = [];
  let cursor;
  do {
    const page = await env.RAFTER_CLIENTS.list({ prefix: CLIENT_PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) {
      const uuid = k.name.slice(CLIENT_PREFIX.length);
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) continue;
      tenants.push({ uuid });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // Enrich each tenant. Bounded fan-out (Promise.all over the per-tenant set);
  // tradie working set is on the order of tens, so a flat parallel resolve is
  // fine. Reconsider if the platform crosses ~200 tenants.
  await Promise.all(tenants.map((t) => enrichTenantSummary(t, env)));

  // Aggregate counts for the console summary cards (computed here so the UI
  // doesn't have to re-derive — keeps the console rendering trivial).
  const aggregates = {
    total: tenants.length,
    by_environment: { dev: 0, bvt: 0, prod: 0, unset: 0 },
    sm8_connected: tenants.filter(t => t.sm8_connected).length,
    quotes_last_7d: tenants.reduce((acc, t) => acc + (t.quotes_last_7d || 0), 0),
    drafts_total: tenants.reduce((acc, t) => acc + (t.drafts || 0), 0),
  };
  for (const t of tenants) {
    const env_ = t.environment && VALID_ENVIRONMENTS.has(t.environment) ? t.environment : 'unset';
    aggregates.by_environment[env_] += 1;
  }

  return json({ ok: true, tenants, aggregates });
}

async function enrichTenantSummary(t, env) {
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + t.uuid).catch(() => null);
  if (!raw) { t.error = 'kv_record_missing'; return; }
  let rec;
  try { rec = JSON.parse(raw); }
  catch { t.error = 'kv_record_corrupt'; return; }

  t.slug = rec.slug || '';
  t.company_name = rec.company_name || '';
  t.environment = rec.environment || null;
  t.gate_enforced = rec.gate_enforced !== false; // default true (RFT-87 b flip)
  t.sm8_connected = !!rec.access_token;
  t.token_expires_at = rec.expires_at || null;
  t.materials_synced_at = rec.materials_synced_at || null;
  t.clerk_org_id = rec.clerk_org_id || null;
  t.created_at = rec.connected_at || null;

  // Clerk org enrichment — best effort, never a hard failure.
  if (t.clerk_org_id) {
    const orgRes = await clerkFetch(env, `/v1/organizations/${encodeURIComponent(t.clerk_org_id)}`);
    if (orgRes.ok && orgRes.data) {
      t.clerk = {
        name: orgRes.data.name || '',
        members_count: orgRes.data.members_count ?? null,
        slug: orgRes.data.slug || '',
      };
    } else {
      t.clerk = null;
      t.clerk_error = orgRes.error || `clerk_${orgRes.status}`;
    }
  } else {
    t.clerk = null;
  }

  // D1 aggregates — events + quotes counts.
  if (env.RAFTER_EVENTS) {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const ev = await env.RAFTER_EVENTS.prepare(
        `SELECT
           (SELECT MAX(occurred_at) FROM events WHERE client_uuid = ?1 AND event_type = 'quote_submitted') AS last_submit,
           (SELECT COUNT(*) FROM events WHERE client_uuid = ?1 AND event_type = 'quote_submitted') AS submit_count,
           (SELECT COUNT(*) FROM events WHERE client_uuid = ?1 AND event_type = 'quote_submitted' AND occurred_at >= ?2) AS submit_7d`
      ).bind(t.uuid, cutoff).first();
      t.last_quote_submitted_at = ev?.last_submit || null;
      t.quotes_total = ev?.submit_count ?? 0;
      t.quotes_last_7d = ev?.submit_7d ?? 0;
    } catch (e) {
      t.events_error = e.message;
    }
  }
  if (env.RAFTER_QUOTES) {
    try {
      const q = await env.RAFTER_QUOTES.prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS drafts,
           SUM(CASE WHEN status = 'submitted' THEN 1 ELSE 0 END) AS submitted,
           SUM(CASE WHEN status = 'superseded' THEN 1 ELSE 0 END) AS superseded
         FROM quotes WHERE client_uuid = ?1`
      ).bind(t.uuid).first();
      t.quotes_in_d1 = q?.total ?? 0;
      t.drafts = q?.drafts ?? 0;
      t.submitted_in_d1 = q?.submitted ?? 0;
      t.superseded_in_d1 = q?.superseded ?? 0;
    } catch (e) {
      t.quotes_error = e.message;
    }
  }
}

// GET /console/tenants/:uuid — single-tenant detail. Same shape as the list
// entry plus R2 stats + last-10 events + last-10 quotes.
async function handleConsoleTenantDetail(uuid, env) {
  const t = { uuid };
  await enrichTenantSummary(t, env);
  if (t.error) return json({ ok: false, error: t.error, uuid }, 404);

  // R2 stats — count + total bytes + per-category breakdown.
  if (env.RAFTER_ASSETS) {
    const prefix = `clients/${uuid}/photos/`;
    let count = 0, bytes = 0;
    const byCategory = {};
    let cursor;
    do {
      const page = await env.RAFTER_ASSETS.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        count += 1;
        bytes += obj.size || 0;
        const rest = obj.key.slice(prefix.length);
        const slash = rest.indexOf('/');
        const cat = slash >= 0 ? rest.slice(0, slash) : '_root';
        byCategory[cat] = (byCategory[cat] || 0) + 1;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    t.r2 = { photo_count: count, photo_bytes: bytes, by_category: byCategory };
  }

  // Last 10 events.
  if (env.RAFTER_EVENTS) {
    try {
      const res = await env.RAFTER_EVENTS.prepare(
        'SELECT id, event_type, occurred_at, payload FROM events WHERE client_uuid = ? ORDER BY occurred_at DESC LIMIT 10'
      ).bind(uuid).all();
      t.recent_events = (res.results || []).map(r => {
        let payload = null;
        try { payload = r.payload ? JSON.parse(r.payload) : null; } catch { payload = { _raw: (r.payload || '').slice(0, 200) }; }
        return { id: r.id, event_type: r.event_type, occurred_at: r.occurred_at, payload };
      });
    } catch (e) { t.events_error = e.message; t.recent_events = []; }
  }

  // Last 10 quotes.
  if (env.RAFTER_QUOTES) {
    try {
      const res = await env.RAFTER_QUOTES.prepare(
        'SELECT quote_ref, status, version, sm8_job_uuid, created_at, updated_at FROM quotes WHERE client_uuid = ? ORDER BY updated_at DESC LIMIT 10'
      ).bind(uuid).all();
      t.recent_quotes = res.results || [];
    } catch (e) { t.quotes_error = e.message; t.recent_quotes = []; }
  }

  return json({ ok: true, tenant: t });
}

// POST /console/tenants/:uuid/teardown — full platform-side teardown. Same
// ordered cleanup as RFT-30 plus the Clerk org delete (platform operator can
// delete the Clerk side; tenant self-teardown cannot). Prod environment
// requires confirm_slug match to dodge a wrong-tenant clobber.
async function handleConsoleTeardown(uuid, request, env, operatorUserId) {
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'client_not_found', uuid }, 404);
  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }

  const environment = record.environment || null;
  const slug = record.slug || null;
  const clerkOrgId = record.clerk_org_id || null;

  // Prod safety gate. Only environment === 'prod' demands the slug-typing
  // confirmation (Linear-style delete-repo prompt). dev / bvt / unset all
  // proceed with no second-factor — they're either explicitly non-prod or
  // unconfigured tenants where teardown is the natural cleanup. The earlier
  // "unset === prod fail-safe" was deliberately relaxed in RFT-132 once
  // the orphan-cleanup pass left only tagged tenants in the live set;
  // operators can still pre-tag a tenant via the env dropdown if they want
  // the prod gate to fire.
  if (environment === 'prod') {
    let body = null;
    try { body = await request.json(); } catch {}
    const confirmSlug = body?.confirm_slug;
    if (!confirmSlug || confirmSlug !== slug) {
      return json({
        ok: false, error: 'prod_confirmation_required',
        detail: `Type the tenant's slug as body.confirm_slug to confirm. environment=${environment ?? 'unset'} (treated as prod).`,
        expected: slug,
      }, 400);
    }
  }

  const report = {
    uuid, slug, environment,
    clerk_org_deleted: false,
    clerk_error: null,
    r2_objects_deleted: 0,
    quotes_deleted: 0,
    events_deleted: 0,
    operator_user_id: operatorUserId,
    at: new Date().toISOString(),
  };

  // 1. Clerk org delete — best effort. A Clerk failure does NOT stop the
  //    KV/R2/D1 cleanup; the operator can re-issue the Clerk delete from
  //    the dashboard if it didn't take.
  if (clerkOrgId) {
    const del = await clerkFetch(env, `/v1/organizations/${encodeURIComponent(clerkOrgId)}`, { method: 'DELETE' });
    report.clerk_org_deleted = del.ok;
    if (!del.ok) report.clerk_error = del.error || `clerk_${del.status}`;
    console.log(JSON.stringify({ event: 'console_clerk_org_delete', uuid, clerkOrgId, ok: del.ok, status: del.status }));
  }

  // 2. R2 — list and batch-delete under the tenant prefix.
  if (env.RAFTER_ASSETS) {
    const r2Prefix = `clients/${uuid}/`;
    let cursor;
    do {
      const page = await env.RAFTER_ASSETS.list({ prefix: r2Prefix, cursor, limit: 1000 });
      if (page.objects.length === 0) break;
      const keys = page.objects.map((o) => o.key);
      await env.RAFTER_ASSETS.delete(keys);
      report.r2_objects_deleted += keys.length;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  // 3. D1 rafter-quotes — all rows.
  if (env.RAFTER_QUOTES) {
    try {
      const res = await env.RAFTER_QUOTES.prepare('DELETE FROM quotes WHERE client_uuid = ?').bind(uuid).run();
      report.quotes_deleted = res.meta?.changes ?? 0;
    } catch (e) { report.quotes_error = e.message; }
  }

  // 4. D1 rafter-events — all rows.
  if (env.RAFTER_EVENTS) {
    try {
      const res = await env.RAFTER_EVENTS.prepare('DELETE FROM events WHERE client_uuid = ?').bind(uuid).run();
      report.events_deleted = res.meta?.changes ?? 0;
    } catch (e) { report.events_error = e.message; }
  }

  // 5. KV reverse indexes + canonical record. canonical LAST so a partial-
  //    failure leaves a discoverable record for retry, not orphan indexes.
  if (record.slug) await env.RAFTER_CLIENTS.delete(SLUG_PREFIX + record.slug).catch(() => {});
  if (clerkOrgId) await env.RAFTER_CLIENTS.delete('clerk_org:' + clerkOrgId).catch(() => {});
  await env.RAFTER_CLIENTS.delete(CLIENT_PREFIX + uuid);

  // 6. Telegram alert — fire-and-forget. Console teardown is a paging event
  //    (irreversible action on production data, even for dev/bvt — operator
  //    error visibility wins over alert noise).
  const tg =
    `🗑️ Tenant torn down (${environment || 'unset'})\n` +
    `slug=${slug || '?'} uuid=${uuid}\n` +
    `clerk_org=${report.clerk_org_deleted ? 'deleted' : (clerkOrgId ? 'failed' : 'none')}\n` +
    `r2=${report.r2_objects_deleted} quotes=${report.quotes_deleted} events=${report.events_deleted}\n` +
    `by ${operatorUserId}`;
  sendTelegramAlert(tg, env).catch(() => {});

  return json({ ok: true, torn_down: true, ...report });
}

// POST /console/tenants/:uuid/environment — set environment tag.
async function handleConsoleSetEnvironment(uuid, request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid_json' }, 400); }
  const environment = body?.environment;
  if (!VALID_ENVIRONMENTS.has(environment)) {
    return json({ ok: false, error: 'invalid_environment', allowed: [...VALID_ENVIRONMENTS] }, 400);
  }
  const ok = await mutateClientRecord(uuid, env, (rec) => { rec.environment = environment; });
  if (!ok) return json({ ok: false, error: 'client_not_found' }, 404);
  return json({ ok: true, uuid, environment });
}

// POST /console/backfill-environment — one-shot. Sets environment on the
// two legacy non-prod tenants (dev + bvt). Andy's record is INTENTIONALLY
// not included; Will sets it via /console/tenants/:uuid/environment after
// review. New tenants set the field at provision time (separate ticket).
const BACKFILL_TARGETS = [
  { uuid: '010895db-e06c-465d-bce9-2424477be15b', environment: 'dev' },
  { uuid: 'df902850-7e48-4e7a-8f2c-b3a65b6881da', environment: 'bvt' },
];
async function handleConsoleBackfillEnvironment(env) {
  const report = [];
  for (const target of BACKFILL_TARGETS) {
    const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + target.uuid).catch(() => null);
    if (!raw) { report.push({ ...target, action: 'skipped_not_found' }); continue; }
    let rec;
    try { rec = JSON.parse(raw); }
    catch { report.push({ ...target, action: 'skipped_corrupt' }); continue; }
    if (rec.environment === target.environment) {
      report.push({ ...target, action: 'noop_already_set' });
      continue;
    }
    const previous = rec.environment ?? null;
    const ok = await mutateClientRecord(target.uuid, env, (r) => { r.environment = target.environment; });
    report.push({ ...target, action: ok ? 'set' : 'failed', previous });
  }
  return json({
    ok: true,
    targets_attempted: BACKFILL_TARGETS.length,
    report,
    note: "Andy's record (0e604a45-…) is excluded — set via POST /console/tenants/{uuid}/environment after explicit review.",
  });
}

// ── RFT-123: Observability ───────────────────────────────────────────────────
//
// GET /console/observability — paginated event feed with tenant/type/since
//                              filters. Reads rafter-events.events directly.
// GET /console/observability/summary — 24h/7d aggregates for the console
//                              summary cards.
//
// Column note: the events table's timestamp column is `occurred_at` (TEXT,
// ISO string), set by writeD1Event across all workers (RFT-90 + RFT-96).
// Brief said `created_at`; the actual schema is `occurred_at`. Sort + filter
// on that.

const OBSERVABILITY_DEFAULT_SINCE_DAYS = 7;
const OBSERVABILITY_DEFAULT_LIMIT = 50;
const OBSERVABILITY_MAX_LIMIT = 200;

async function handleConsoleObservability(url, env) {
  if (!env.RAFTER_EVENTS) {
    return json({ ok: false, error: 'rafter_events_not_bound' }, 503);
  }
  const tenantUuid = url.searchParams.get('tenant_uuid');
  const eventType = url.searchParams.get('event_type');
  let since = url.searchParams.get('since');
  let limit = parseInt(url.searchParams.get('limit') || '', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = OBSERVABILITY_DEFAULT_LIMIT;
  if (limit > OBSERVABILITY_MAX_LIMIT) limit = OBSERVABILITY_MAX_LIMIT;

  if (tenantUuid && !/^[0-9a-f-]{36}$/i.test(tenantUuid)) {
    return json({ ok: false, error: 'invalid_tenant_uuid' }, 400);
  }
  if (!since) {
    since = new Date(Date.now() - OBSERVABILITY_DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  }

  // Build the WHERE with parameterised bindings — no string concat with user
  // input. The clauses are appended conditionally so a missing filter doesn't
  // reduce the result set unnecessarily.
  const where = ['occurred_at >= ?'];
  const binds = [since];
  if (tenantUuid) { where.push('client_uuid = ?'); binds.push(tenantUuid); }
  if (eventType) { where.push('event_type = ?'); binds.push(eventType); }
  const whereSql = where.join(' AND ');

  let events = [];
  let total = 0;
  try {
    const rowsRes = await env.RAFTER_EVENTS.prepare(
      `SELECT id, client_uuid, event_type, occurred_at, payload
         FROM events WHERE ${whereSql}
         ORDER BY occurred_at DESC LIMIT ?`
    ).bind(...binds, limit).all();
    events = (rowsRes.results || []).map(r => {
      let payload = null;
      if (r.payload) {
        try { payload = JSON.parse(r.payload); }
        catch { payload = { _raw: String(r.payload).slice(0, 300) }; }
      }
      return { id: r.id, client_uuid: r.client_uuid, event_type: r.event_type, occurred_at: r.occurred_at, payload };
    });
    const countRes = await env.RAFTER_EVENTS.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE ${whereSql}`
    ).bind(...binds).first();
    total = countRes?.n ?? 0;
  } catch (e) {
    return json({ ok: false, error: 'd1_read_failed', detail: e.message }, 502);
  }

  return json({ ok: true, events, total_count: total, since, limit, filters: { tenant_uuid: tenantUuid || null, event_type: eventType || null } });
}

async function handleConsoleObservabilitySummary(env) {
  if (!env.RAFTER_EVENTS) {
    return json({ ok: false, error: 'rafter_events_not_bound' }, 503);
  }
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Aggregate in one batched call where possible — D1 supports batch() but
    // each prepare/bind/run is also cheap on a 5-row events table. Five
    // sequential awaits is fine for current scale (rafter-events row count is
    // in the hundreds).
    const events24hRow = await env.RAFTER_EVENTS.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE occurred_at >= ?'
    ).bind(since24h).first();
    const events7dRow = await env.RAFTER_EVENTS.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE occurred_at >= ?'
    ).bind(since7d).first();
    const ctaRow = await env.RAFTER_EVENTS.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE event_type = 'cross_tenant_attempt' AND occurred_at >= ?"
    ).bind(since7d).first();
    const byTypeRes = await env.RAFTER_EVENTS.prepare(
      'SELECT event_type, COUNT(*) AS n FROM events WHERE occurred_at >= ? GROUP BY event_type ORDER BY n DESC'
    ).bind(since7d).all();
    const byTenantRes = await env.RAFTER_EVENTS.prepare(
      'SELECT client_uuid, COUNT(*) AS n FROM events WHERE occurred_at >= ? AND client_uuid IS NOT NULL GROUP BY client_uuid ORDER BY n DESC LIMIT 20'
    ).bind(since7d).all();

    // Enrich by_tenant with slug/company from KV — bounded list (max 20).
    const byTenant = [];
    for (const row of (byTenantRes.results || [])) {
      const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + row.client_uuid).catch(() => null);
      let slug = null, company = null, environment = null;
      if (raw) {
        try {
          const rec = JSON.parse(raw);
          slug = rec.slug || null;
          company = rec.company_name || null;
          environment = rec.environment || null;
        } catch { /* leave nulls */ }
      }
      byTenant.push({ uuid: row.client_uuid, slug, company, environment, event_count: row.n });
    }

    const byType = {};
    for (const row of (byTypeRes.results || [])) byType[row.event_type] = row.n;

    return json({
      ok: true,
      events_24h: events24hRow?.n ?? 0,
      events_7d: events7dRow?.n ?? 0,
      cross_tenant_attempts_7d: ctaRow?.n ?? 0,
      by_type: byType,
      by_tenant: byTenant,
      windows: { since_24h: since24h, since_7d: since7d },
    });
  } catch (e) {
    return json({ ok: false, error: 'd1_read_failed', detail: e.message }, 502);
  }
}

// ── RFT-124: Team & access ───────────────────────────────────────────────────
//
// Cross-org aggregator — KV list every tenant, fan out per-org Clerk Backend
// API reads (org + memberships + pending invites). Per-org failures degrade
// gracefully into a null entry rather than breaking the whole response.
// Pagination handled per-call — current scale is tens of members across two
// orgs, but the limit is parameterised so the math holds when it grows.

async function handleConsoleTeam(env) {
  // KV scan — same shape as handleConsoleTenants. We need the full client
  // record for environment + slug + company, so this is a JSON parse per
  // tenant. Bounded fan-out for the Clerk calls (Promise.all over the orgs).
  const tenants = [];
  let cursor;
  do {
    const page = await env.RAFTER_CLIENTS.list({ prefix: CLIENT_PREFIX, cursor, limit: 1000 });
    for (const k of page.keys) {
      const uuid = k.name.slice(CLIENT_PREFIX.length);
      if (!/^[0-9a-f-]{36}$/i.test(uuid)) continue;
      const raw = await env.RAFTER_CLIENTS.get(k.name).catch(() => null);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw);
        tenants.push({
          uuid,
          slug: rec.slug || null,
          company: rec.company_name || null,
          environment: rec.environment || null,
          clerk_org_id: rec.clerk_org_id || null,
        });
      } catch { /* skip corrupt records — they'll surface in the unbound list as a different ticket if it matters */ }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const unbound = tenants.filter(t => !t.clerk_org_id);
  const withOrg = tenants.filter(t => t.clerk_org_id);

  // Per-org fan-out. Each org gets three Clerk calls — org details +
  // memberships + pending invites. A single per-call failure is recorded in
  // the org's error field, the rest of the data populates.
  const orgs = await Promise.all(withOrg.map(async (t) => {
    return await fetchOrgWithMembersAndInvites(env, t);
  }));

  const totals = orgs.reduce((acc, o) => {
    acc.members += (o.members?.length || 0);
    acc.pending_invites += (o.pending_invites?.length || 0);
    return acc;
  }, { members: 0, pending_invites: 0 });

  return json({
    ok: true,
    summary: {
      total_tenants: tenants.length,
      total_orgs: orgs.length,
      total_members: totals.members,
      total_pending_invites: totals.pending_invites,
      unbound_tenants: unbound.length,
    },
    orgs,
    unbound_tenants: unbound.map(t => ({ uuid: t.uuid, slug: t.slug, company: t.company, environment: t.environment })),
  });
}

const TEAM_MEMBER_PAGE_LIMIT = 100;
const TEAM_INVITE_PAGE_LIMIT = 100;

async function fetchOrgWithMembersAndInvites(env, tenant) {
  const out = {
    tenant_uuid: tenant.uuid,
    tenant_slug: tenant.slug,
    tenant_company: tenant.company,
    tenant_environment: tenant.environment,
    org_id: tenant.clerk_org_id,
    org_name: null,
    org_slug: null,
    org_created_at: null,
    members: [],
    pending_invites: [],
    error: null,
  };

  // Org details.
  const orgRes = await clerkFetch(env, `/v1/organizations/${encodeURIComponent(tenant.clerk_org_id)}`);
  if (orgRes.ok && orgRes.data) {
    out.org_name = orgRes.data.name || null;
    out.org_slug = orgRes.data.slug || null;
    out.org_created_at = orgRes.data.created_at || null;
  } else {
    out.error = `org_${orgRes.status || 'fetch_failed'}`;
    // Continue — the membership endpoint may still work.
  }

  // Memberships — paginated. Stop once the page returns fewer than the limit.
  try {
    let offset = 0;
    while (true) {
      const memRes = await clerkFetch(env,
        `/v1/organizations/${encodeURIComponent(tenant.clerk_org_id)}/memberships?limit=${TEAM_MEMBER_PAGE_LIMIT}&offset=${offset}`
      );
      if (!memRes.ok || !memRes.data) {
        out.members_error = `memberships_${memRes.status || 'fetch_failed'}`;
        break;
      }
      const rows = Array.isArray(memRes.data.data) ? memRes.data.data : (Array.isArray(memRes.data) ? memRes.data : []);
      for (const m of rows) {
        const u = m.public_user_data || m.user || {};
        out.members.push({
          user_id: u.user_id || u.id || null,
          email: u.identifier || u.email_address || null,
          first_name: u.first_name || null,
          last_name: u.last_name || null,
          role: m.role || null,
          created_at: m.created_at || null,
        });
      }
      if (rows.length < TEAM_MEMBER_PAGE_LIMIT) break;
      offset += rows.length;
      if (offset > 1000) break; // safety stop — no real org has 1000+ members on this platform
    }
  } catch (e) {
    out.members_error = e.message;
  }

  // Pending invitations — paginated.
  try {
    let offset = 0;
    while (true) {
      const invRes = await clerkFetch(env,
        `/v1/organizations/${encodeURIComponent(tenant.clerk_org_id)}/invitations?status=pending&limit=${TEAM_INVITE_PAGE_LIMIT}&offset=${offset}`
      );
      if (!invRes.ok || !invRes.data) {
        out.invites_error = `invitations_${invRes.status || 'fetch_failed'}`;
        break;
      }
      const rows = Array.isArray(invRes.data.data) ? invRes.data.data : (Array.isArray(invRes.data) ? invRes.data : []);
      for (const inv of rows) {
        out.pending_invites.push({
          id: inv.id || null,
          email: inv.email_address || inv.email || null,
          role: inv.role || null,
          created_at: inv.created_at || null,
        });
      }
      if (rows.length < TEAM_INVITE_PAGE_LIMIT) break;
      offset += rows.length;
      if (offset > 1000) break;
    }
  } catch (e) {
    out.invites_error = e.message;
  }

  return out;
}

// ── RFT-127: Platform health ─────────────────────────────────────────────────
//
// Cross-provider health view for the console. Pulls from Cloudflare REST +
// GraphQL Analytics. Every external call wrapped in try/catch — a provider
// outage degrades to nulls in the response, never 500s the whole endpoint.
//
// Required env (all optional — missing tokens produce null sections, not errors):
//   CLOUDFLARE_ANALYTICS_TOKEN — Bearer token with Account.Workers Scripts:Read
//                                + Account.Analytics:Read scopes
//   CLOUDFLARE_ACCOUNT_ID      — account tag for analytics queries

const TRACKED_WORKERS = ['rafter', 'rafter-pdf', 'rafter-materials-sync', 'rafter-admin-api', 'rafter-ops-console'];

async function cfFetch(env, path, init = {}) {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) return { ok: false, status: 503, error: 'cloudflare_analytics_token_not_set' };
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    const res = await fetch(`https://api.cloudflare.com${path}`, { ...init, headers });
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; } }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function cfGraphQL(env, query, variables) {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN) return { ok: false, error: 'cloudflare_analytics_token_not_set' };
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: data?.errors?.[0]?.message || `http_${res.status}` };
    if (data?.errors?.length) return { ok: false, status: res.status, error: data.errors[0].message };
    return { ok: true, data: data?.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleConsolePlatformHealth(env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || '';
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Per-worker analytics + deployments. Parallel fan-out — five workers,
  // two requests each (analytics + deployments). Each call's failure stays
  // local to that worker's entry.
  const workers = await Promise.all(TRACKED_WORKERS.map(async (name) => {
    const out = { name, requests_7d: null, errors_7d: null, error_rate: null, p50_cpu_ms: null, p99_cpu_ms: null, daily: [], recent_deploys: [] };

    // GraphQL analytics. workersInvocationsAdaptive is the Workers dataset;
    // grouped by date for the sparkline. quantiles give p50/p99 CPU time
    // in microseconds (we convert to ms on the way out).
    const gql = `query($accountId:String!,$scriptName:String!,$since:Time!){
      viewer{accounts(filter:{accountTag:$accountId}){
        workersInvocationsAdaptive(
          filter:{scriptName:$scriptName, datetime_geq:$since},
          limit:10000,
          orderBy:[date_ASC]
        ){
          sum{requests errors subrequests}
          quantiles{cpuTimeP50 cpuTimeP99}
          dimensions{date}
        }
      }}
    }`;
    const aRes = await cfGraphQL(env, gql, { accountId, scriptName: name, since });
    if (aRes.ok && aRes.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive) {
      const rows = aRes.data.viewer.accounts[0].workersInvocationsAdaptive;
      let totalReq = 0, totalErr = 0, p50us = 0, p99us = 0, n = 0;
      for (const row of rows) {
        const req = row.sum?.requests || 0;
        const err = row.sum?.errors || 0;
        totalReq += req; totalErr += err;
        p50us += row.quantiles?.cpuTimeP50 || 0;
        p99us += row.quantiles?.cpuTimeP99 || 0;
        n++;
        out.daily.push({ date: row.dimensions?.date || '', requests: req, errors: err });
      }
      out.requests_7d = totalReq;
      out.errors_7d = totalErr;
      out.error_rate = totalReq > 0 ? totalErr / totalReq : 0;
      out.p50_cpu_ms = n > 0 ? Math.round((p50us / n) / 1000 * 100) / 100 : null;
      out.p99_cpu_ms = n > 0 ? Math.round((p99us / n) / 1000 * 100) / 100 : null;
    } else {
      out.analytics_error = aRes.error || `gql_${aRes.status || 'failed'}`;
    }

    // Recent deployments — last 5. Endpoint returns paginated results; we
    // only need the first page sorted desc.
    const dRes = await cfFetch(env, `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(name)}/deployments`);
    if (dRes.ok && Array.isArray(dRes.data?.result?.deployments)) {
      out.recent_deploys = dRes.data.result.deployments.slice(0, 5).map(d => ({
        version_id: d.versions?.[0]?.version_id || d.id || null,
        created_at: d.created_on || d.metadata?.created_on || null,
      }));
    } else {
      out.deploys_error = dRes.error || `deploys_${dRes.status || 'failed'}`;
    }
    return out;
  }));

  // Storage stats — best-effort, individual try/catch. The endpoint shapes
  // differ between KV/R2/D1 and not every metric is exposed via REST.
  const storage = { kv: null, r2: null, d1: [] };

  // R2 bucket head — object count + size aren't first-class on the REST
  // bucket endpoint; the bucket listing only returns metadata. We list
  // objects with limit=1 + use the response's truncated/cursor pattern,
  // OR just hit the bucket endpoint and return whatever shows. For real
  // counts the worker-side R2 binding is better, but this endpoint runs
  // outside that context — leave object_count null for now.
  try {
    const r2Res = await cfFetch(env, `/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/rafter-assets`);
    if (r2Res.ok && r2Res.data?.result) {
      storage.r2 = { bucket: 'rafter-assets', creation_date: r2Res.data.result.creation_date || null, object_count: null, total_size_bytes: null };
    }
  } catch { /* ignore */ }

  // KV namespace metadata.
  try {
    const kvRes = await cfFetch(env, `/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`);
    if (kvRes.ok && Array.isArray(kvRes.data?.result)) {
      const list = kvRes.data.result;
      storage.kv = {
        namespace_count: list.length,
        namespaces: list.map(n => ({ id: n.id, title: n.title })),
      };
    }
  } catch { /* ignore */ }

  // D1 databases.
  try {
    const dbRes = await cfFetch(env, `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database`);
    if (dbRes.ok && Array.isArray(dbRes.data?.result)) {
      storage.d1 = dbRes.data.result.map(db => ({
        name: db.name,
        id: db.uuid,
        file_size_bytes: db.file_size ?? null,
        num_tables: db.num_tables ?? null,
        version: db.version ?? null,
      }));
    }
  } catch { /* ignore */ }

  return json({ ok: true, workers, storage, generated_at: new Date().toISOString() });
}

// ── RFT-128: Issues (Linear) ─────────────────────────────────────────────────
//
// Linear GraphQL aggregator. The team key is "RFT" per CLAUDE.md. The token
// is a personal API key with read scope. Auth header is bare (no "Bearer "
// prefix) per Linear's docs.

async function linearGraphQL(env, query, variables) {
  if (!env.LINEAR_API_TOKEN) return { ok: false, error: 'linear_token_not_set' };
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Authorization': env.LINEAR_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: data?.errors?.[0]?.message || `http_${res.status}` };
    if (data?.errors?.length) return { ok: false, error: data.errors[0].message };
    return { ok: true, data: data?.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleConsoleIssues(env) {
  // Single query — pulls open + recently-completed in one round trip.
  // priorityLabel resolves the priority number (0-4) to a string Linear
  // returns ("Urgent", "High", etc.). state.type is one of triage/backlog/
  // unstarted/started/completed/canceled.
  const query = `
    query {
      open: issues(
        filter: { team: { key: { eq: "RFT" } }, state: { type: { nin: ["completed","canceled"] } } }
        first: 100
        orderBy: updatedAt
      ) {
        nodes {
          id identifier title priority priorityLabel url
          state { name type }
          labels { nodes { name color } }
          assignee { name email }
          createdAt updatedAt
        }
      }
      completedRecent: issues(
        filter: { team: { key: { eq: "RFT" } }, state: { type: { eq: "completed" } }, completedAt: { gte: "-P7D" } }
        first: 100
        orderBy: updatedAt
      ) {
        nodes { id identifier title completedAt }
      }
    }
  `;
  const res = await linearGraphQL(env, query);
  if (!res.ok) {
    return json({ ok: false, error: 'linear_query_failed', detail: res.error }, 502);
  }
  const open = res.data?.open?.nodes || [];
  const completed7d = res.data?.completedRecent?.nodes || [];

  const byPriority = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 };
  const byState = { backlog: 0, unstarted: 0, started: 0, triage: 0 };
  for (const i of open) {
    const p = (i.priorityLabel || 'none').toLowerCase();
    if (byPriority[p] !== undefined) byPriority[p]++;
    else byPriority.none++;
    const st = (i.state?.type || 'unstarted').toLowerCase();
    if (byState[st] !== undefined) byState[st]++;
    else byState.unstarted++;
  }

  const issues = open.map(i => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    priority: i.priority,
    priority_label: i.priorityLabel,
    state: i.state?.name || null,
    state_type: i.state?.type || null,
    labels: (i.labels?.nodes || []).map(l => ({ name: l.name, color: l.color })),
    assignee: i.assignee?.name || null,
    url: i.url,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
  }));

  return json({
    ok: true,
    summary: {
      total_open: open.length,
      by_priority: byPriority,
      by_state: byState,
      completed_7d: completed7d.length,
    },
    issues,
  });
}

// ── RFT-129: Make scenarios ──────────────────────────────────────────────────
//
// Make REST API aggregator. Auth uses "Token <token>" header per Make's docs
// and confirmed by the existing materials-sync probe path. Lightweight
// 5-minute in-memory cache because the console may poll on every nav-click
// and Make's rate limits are tight.

const MAKE_CACHE = { data: null, expires_at: 0 };
const MAKE_CACHE_TTL_MS = 5 * 60 * 1000;

async function makeFetch(env, path) {
  if (!env.MAKE_API_TOKEN) return { ok: false, error: 'make_token_not_set' };
  const base = env.MAKE_API_BASE_URL || 'https://eu1.make.com';
  try {
    const res = await fetch(`${base}${path}`, { headers: { 'Authorization': `Token ${env.MAKE_API_TOKEN}` } });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: data?.message || `http_${res.status}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleConsoleMakeScenarios(env) {
  // Serve cached if fresh.
  if (MAKE_CACHE.data && Date.now() < MAKE_CACHE.expires_at) {
    return json({ ...MAKE_CACHE.data, cached: true, cache_age_ms: Date.now() - (MAKE_CACHE.expires_at - MAKE_CACHE_TTL_MS) });
  }

  const listRes = await makeFetch(env, '/api/v2/scenarios');
  if (!listRes.ok) return json({ ok: false, error: 'make_list_failed', detail: listRes.error }, 502);
  const scenarios = Array.isArray(listRes.data?.scenarios) ? listRes.data.scenarios : (Array.isArray(listRes.data) ? listRes.data : []);

  // Derive org from the first scenario (Make scenarios all belong to one team/org).
  const orgId = scenarios[0]?.organizationId || scenarios[0]?.teamId || null;
  let plan = null;
  if (orgId) {
    const usageRes = await makeFetch(env, `/api/v2/organizations/${encodeURIComponent(orgId)}/usage`);
    if (usageRes.ok && usageRes.data) {
      const u = usageRes.data;
      plan = {
        credits_limit: u.operations_limit ?? u.credits_limit ?? null,
        credits_used: u.operations_used ?? u.credits_used ?? null,
        credits_remaining: u.operations_remaining ?? u.credits_remaining ?? null,
        reset_date: u.reset_date ?? u.next_reset ?? null,
      };
    }
  }

  // Per-scenario 30-day consumption. Bounded fan-out — the platform has
  // maybe two scenarios; this won't blow out even with a few.
  const scenarioDetails = await Promise.all(scenarios.map(async (s) => {
    const id = s.id;
    let ops30d = null, credits30d = null;
    try {
      const cRes = await makeFetch(env, `/api/v2/scenarios/${encodeURIComponent(id)}/consumptions`);
      if (cRes.ok && cRes.data) {
        const rows = Array.isArray(cRes.data.consumptions) ? cRes.data.consumptions : (Array.isArray(cRes.data) ? cRes.data : []);
        ops30d = rows.reduce((a, r) => a + (r.operations || r.ops || 0), 0);
        credits30d = rows.reduce((a, r) => a + (r.centicredits ? r.centicredits / 100 : (r.credits || 0)), 0);
      }
    } catch { /* per-scenario consumption is non-critical */ }

    return {
      id,
      name: s.name || `Scenario ${id}`,
      is_active: !!s.isActive && !s.isPaused,
      is_paused: !!s.isPaused,
      last_execution_at: s.lastExecution || s.lastExecutionAt || null,
      operations_30d: ops30d,
      credits_30d: credits30d,
    };
  }));

  const active = scenarioDetails.filter(s => s.is_active).length;
  const paused = scenarioDetails.filter(s => s.is_paused).length;
  const total_ops_30d = scenarioDetails.reduce((a, s) => a + (s.operations_30d || 0), 0);
  const total_credits_30d = scenarioDetails.reduce((a, s) => a + (s.credits_30d || 0), 0);

  const payload = {
    ok: true,
    summary: {
      total_scenarios: scenarioDetails.length,
      active, paused,
      total_operations_30d: total_ops_30d,
      total_credits_30d,
    },
    plan,
    scenarios: scenarioDetails,
  };
  MAKE_CACHE.data = payload;
  MAKE_CACHE.expires_at = Date.now() + MAKE_CACHE_TTL_MS;
  return json({ ...payload, cached: false });
}

// ── RFT-130: Cost & usage ────────────────────────────────────────────────────
//
// Aggregates the other console endpoints + a static PLAN_CONFIG table.
// PLAN_CONFIG is a known-values code constant — update inline when plans
// change. Building a UI editor for two providers' billing tiers is a worse
// use of time than just editing this constant.

const PLAN_CONFIG = {
  cloudflare: { plan: 'Workers Free', monthly_cost: 0, currency: 'USD', notes: 'Free tier across Workers, KV, R2, D1' },
  make: { plan: 'Core', monthly_cost: 9, currency: 'USD', notes: 'Core plan; 10K operations/month' },
  clerk: { plan: 'Pro', monthly_cost: 25, currency: 'USD', notes: 'Pro plan; 1000 MAU included, $0.02/MAU after' },
  domain: { plan: 'au registry', monthly_cost: 25 / 12, currency: 'AUD', notes: 'deepgreensea.au annual / 12' },
};

const CLOUDFLARE_FREE_LIMITS = {
  workers_requests_per_day: 100_000,
  kv_storage_gb: 1,
  r2_storage_gb: 10,
  d1_reads_per_day: 5_000_000,
  d1_writes_per_day: 100_000,
};

const MAKE_OPS_LIMIT = 10_000;     // Core plan operations/month
const CLERK_MAU_INCLUDED = 1000;

async function handleConsoleCostUsage(env) {
  // Pull from our own console endpoints in-process. Each returns a Response
  // object — we read .json() and continue with degraded values when the
  // upstream is unavailable.
  let healthData = null;
  try {
    const r = await handleConsolePlatformHealth(env);
    if (r.ok) healthData = await r.json();
  } catch { /* degrade */ }
  let makeData = null;
  try {
    const r = await handleConsoleMakeScenarios(env);
    if (r.ok) makeData = await r.json();
  } catch { /* degrade */ }

  // Cloudflare daily requests — sum across workers, then average per day to
  // compare against the per-day free-tier limit. 7-day window / 7 = avg.
  const totalReq7d = (healthData?.workers || []).reduce((a, w) => a + (w.requests_7d || 0), 0);
  const dailyReq = totalReq7d / 7;
  const cfReqPct = (dailyReq / CLOUDFLARE_FREE_LIMITS.workers_requests_per_day) * 100;

  // Make operations vs plan limit.
  const makeOps30d = makeData?.summary?.total_operations_30d || 0;
  const makePct = (makeOps30d / MAKE_OPS_LIMIT) * 100;

  const headroomStatus = (pct) => pct >= 90 ? 'critical' : pct >= 70 ? 'warning' : 'ok';

  const providers = [
    {
      name: 'Cloudflare',
      ...PLAN_CONFIG.cloudflare,
      usage: { metric: 'Workers requests/day (7d avg)', current: Math.round(dailyReq), limit: CLOUDFLARE_FREE_LIMITS.workers_requests_per_day, percentage: Math.round(cfReqPct * 10) / 10 },
      headroom_status: headroomStatus(cfReqPct),
    },
    {
      name: 'Make',
      ...PLAN_CONFIG.make,
      usage: { metric: 'Operations (30d)', current: makeOps30d, limit: MAKE_OPS_LIMIT, percentage: Math.round(makePct * 10) / 10 },
      headroom_status: headroomStatus(makePct),
    },
    {
      name: 'Clerk',
      ...PLAN_CONFIG.clerk,
      usage: { metric: 'MAU', current: null, limit: CLERK_MAU_INCLUDED, percentage: null, note: 'MAU lookup not yet wired — Clerk Backend API does not expose org-wide MAU in a single call.' },
      headroom_status: 'ok',
    },
    {
      name: 'Domain (deepgreensea.au)',
      ...PLAN_CONFIG.domain,
      usage: null,
      headroom_status: 'ok',
    },
  ];

  // Monthly total in AUD + USD separately (no FX conversion — exact-to-the-
  // cent isn't the value here, broad-strokes is).
  let totalUsd = 0, totalAud = 0;
  for (const p of providers) {
    if (p.currency === 'USD') totalUsd += p.monthly_cost;
    else if (p.currency === 'AUD') totalAud += p.monthly_cost;
  }

  const alerts = providers
    .filter(p => p.usage && (p.usage.percentage ?? 0) >= 70)
    .map(p => ({
      provider: p.name,
      metric: p.usage.metric,
      percentage: p.usage.percentage,
      current: p.usage.current,
      limit: p.usage.limit,
      message: p.usage.percentage >= 90
        ? `${p.name} ${p.usage.metric} is at ${p.usage.percentage}% — billing imminent if growth continues.`
        : `${p.name} ${p.usage.metric} is at ${p.usage.percentage}% — monitor.`,
    }));

  return json({
    ok: true,
    providers,
    monthly_total: { usd: Math.round(totalUsd * 100) / 100, aud: Math.round(totalAud * 100) / 100 },
    free_tier_alerts: alerts,
    plan_config_note: 'Plan costs are hardcoded in admin-api PLAN_CONFIG. Update inline when plans change.',
    generated_at: new Date().toISOString(),
  });
}

// ── Tenant teardown (RFT-30) ─────────────────────────────────────────────────
//
// DELETE /admin/clients/:uuid — Clerk-JWT + org:admin gated; the URL :uuid
// must match the uuid resolved from the caller's JWT org claim
// (defence-in-depth on top of the JWT verification — same pattern as the
// F-PROV-1 fix). Even with a leaked admin bearer, the org's admin is the
// only caller who can wipe their own tenant.
//
// Order is irreversible-last: R2 photos → R2 logo → D1 quotes → D1 events →
// KV reverse indexes → KV client record. If a step fails partway, the next
// run can retry cleanly because each step is keyed on the stable uuid and
// the KV client record (the index of all the other state) is deleted last.
//
// Does NOT cascade to Clerk — the org membership / org itself stays until a
// human deletes it in the Clerk dashboard. Surfaced in the response so the
// caller knows there's a follow-up step.
async function handleDeleteClient(uuid, request, env, jwtPayload) {
  const gateErr = settingsAdminGate(jwtPayload);
  if (gateErr) return gateErr;

  const orgId = extractOrgId(jwtPayload);
  if (!orgId) return json({ ok: false, error: 'no_org_in_jwt' }, 401);

  const jwtUuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!jwtUuid) return json({ ok: false, error: 'no_tenant_for_org' }, 404);
  if (jwtUuid !== uuid) {
    logCrossTenantAttempt(env, request, { endpoint: '/admin/clients/{uuid}', method: 'DELETE', requested_uuid: uuid, resolved_uuid: jwtUuid, detail: 'URL uuid does not match JWT org claim' });
    return json({ ok: false, error: 'uuid_mismatch', detail: 'URL uuid does not match JWT org claim' }, 403);
  }

  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'client_not_found', uuid }, 404);
  let record;
  try { record = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }

  // 1. R2: delete every object under clients/{uuid}/ (covers photos/, logo, anything else).
  const r2Prefix = `clients/${uuid}/`;
  let r2_objects = 0;
  let cursor;
  do {
    const page = await env.RAFTER_ASSETS.list({ prefix: r2Prefix, cursor, limit: 1000 });
    if (page.objects.length === 0) break;
    const keys = page.objects.map((o) => o.key);
    // R2 delete supports batch by passing an array.
    await env.RAFTER_ASSETS.delete(keys);
    r2_objects += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  // 2. D1 rafter-quotes — all rows for this tenant.
  let quotes_rows = 0;
  if (env.RAFTER_QUOTES) {
    const res = await env.RAFTER_QUOTES.prepare('DELETE FROM quotes WHERE client_uuid = ?').bind(uuid).run();
    quotes_rows = res.meta?.changes ?? 0;
  }

  // 3. D1 rafter-events — all rows for this tenant.
  let events_rows = 0;
  if (env.RAFTER_EVENTS) {
    const res = await env.RAFTER_EVENTS.prepare('DELETE FROM events WHERE client_uuid = ?').bind(uuid).run();
    events_rows = res.meta?.changes ?? 0;
  }

  // 4. KV reverse indexes — slug + clerk_org. Delete before the canonical
  //    record so a partial-failure leaves a discoverable client:{uuid} for
  //    a retry, not an orphaned reverse index pointing at nothing.
  if (record.slug) await env.RAFTER_CLIENTS.delete(SLUG_PREFIX + record.slug).catch(() => {});
  if (record.clerk_org_id) await env.RAFTER_CLIENTS.delete('clerk_org:' + record.clerk_org_id).catch(() => {});

  // 5. KV canonical record — last, because everything else was indexed by uuid.
  await env.RAFTER_CLIENTS.delete(CLIENT_PREFIX + uuid);

  return json({
    ok: true,
    deleted: true,
    uuid,
    r2_objects,
    quotes_rows,
    events_rows,
    clerk_org_id: record.clerk_org_id ?? null,
    note: 'Clerk org NOT cascaded — delete the organization in the Clerk dashboard to complete teardown.',
  });
}

// ── Smoketest — REQ-On-39 to 53 ─────────────────────────────────────────────

async function handleVerify(uuid, url, env) {
  // destructive=false skips SM8 write ops (REQ-On-45/47) — use for production clients
  const destructive = url.searchParams.get('destructive') !== 'false';
  try {
    const result = await runSmoketest(uuid, { destructive }, env);
    const status = result.passed ? 200 : 200; // always 200 — pass/fail in body
    return json({ ok: result.passed, ...result }, status);
  } catch (err) {
    console.error(JSON.stringify({ event: 'smoketest_error', uuid, error: err.message }));
    return json({ ok: false, error: err.message }, 500);
  }
}

async function runSmoketest(uuid, { destructive }, env) {
  const assertions = {};
  let passed = true;

  const fail = (key, reason) => { assertions[key] = { passed: false, reason }; passed = false; };
  const pass = (key, detail) => { assertions[key] = { passed: true, ...(detail && { detail }) }; };
  const skip = (key, reason) => { assertions[key] = { passed: null, skipped: true, reason }; };

  // ── REQ-On-39: KV record integrity ───────────────────────────────────────
  let record = null;
  {
    const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid);
    if (!raw) {
      fail('kv_integrity', `client:${uuid} not found in KV`);
    } else {
      record = JSON.parse(raw);
      const missing = REQUIRED_FIELDS.filter(f => !record[f]);
      if (missing.length) {
        fail('kv_integrity', `missing required fields: ${missing.join(', ')}`);
      } else {
        const slugTarget = await env.RAFTER_CLIENTS.get(SLUG_PREFIX + record.slug);
        if (slugTarget !== uuid) {
          fail('kv_integrity', `slug:${record.slug} → ${slugTarget ?? 'null'}, expected ${uuid}`);
        } else {
          pass('kv_integrity', { slug: record.slug, company_name: record.company_name });
        }
      }
    }
  }

  if (!record) {
    return { passed: false, uuid, assertions };
  }

  // ── REQ-On-40: Correct webhook URL (not stale dev value) ─────────────────
  {
    const wh = record.webhook_url ?? '';
    if (!wh) {
      fail('webhook_url', 'webhook_url is empty');
    } else if (!wh.startsWith('https://hook.eu1.make.com/')) {
      fail('webhook_url', `unexpected webhook domain: ${wh}`);
    } else {
      pass('webhook_url', { url: wh });
    }
  }

  // ── REQ-On-41: Logo serves ────────────────────────────────────────────────
  {
    try {
      const obj = await env.RAFTER_ASSETS.get(`clients/${uuid}/logo.png`);
      if (!obj) {
        fail('logo_serves', `R2 object clients/${uuid}/logo.png not found`);
      } else {
        pass('logo_serves', { size: obj.size });
      }
    } catch (err) {
      fail('logo_serves', err.message);
    }
  }

  // ── REQ-On-42: Materials synced + active-filtered ─────────────────────────
  {
    try {
      const res = await syncFetch(env, `/materials/${uuid}`);
      if (res.status === 404) {
        fail('materials_synced', 'no cached materials — run sync first');
      } else if (!res.ok) {
        fail('materials_synced', `materials endpoint returned ${res.status}`);
      } else {
        const data = await res.json();
        const materials = Array.isArray(data.materials) ? data.materials : [];
        if (materials.length === 0) {
          fail('materials_synced', 'materials cache is empty (active-filter may be missing or sync not run)');
        } else {
          pass('materials_synced', { count: materials.length });
        }
      }
    } catch (err) {
      fail('materials_synced', err.message);
    }
  }

  // ── REQ-On-43: SM8 token valid + refreshable — calls refreshTokenIfNeeded internally ──
  {
    try {
      const res = await syncFetch(env, `/refresh-materials?uuid=${uuid}`);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        fail('token_fresh', `refresh-materials returned ${res.status}: ${detail.slice(0, 200)}`);
      } else {
        pass('token_fresh');
      }
    } catch (err) {
      fail('token_fresh', err.message);
    }
  }

  // ── REQ-On-44 + 45: create_jobs scope + E2E job creation (trial only) ────
  if (!destructive) {
    skip('create_jobs_scope', 'destructive=false — skipped for production clients per REQ-On-45');
  } else {
    // Re-read KV to get fresh token after REQ-On-43 refresh
    const freshRaw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid);
    const freshRecord = freshRaw ? JSON.parse(freshRaw) : null;
    const token = freshRecord?.access_token;

    if (!token) {
      fail('create_jobs_scope', 'access_token missing from KV — complete SM8 OAuth first (REQ-On-36)');
    } else {
      try {
        const createRes = await fetch(`${SM8_BASE}/job.json`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'Quote',
            job_description: `[Rafter smoketest ${uuid.slice(0, 8)} — auto-delete]`,
          }),
        });

        if (createRes.status === 403) {
          fail('create_jobs_scope', 'SM8 returned 403 — create_jobs scope missing from OAuth grant (REQ-On-37)');
        } else if (!createRes.ok) {
          fail('create_jobs_scope', `SM8 POST /job.json returned ${createRes.status}`);
        } else {
          const jobUuid = createRes.headers.get('x-record-uuid'); // VER-03
          if (!jobUuid) {
            fail('create_jobs_scope', 'x-record-uuid header absent from SM8 response (VER-03 — check header not body)');
          } else {
            pass('create_jobs_scope', { job_uuid: jobUuid });
            // Clean up test job immediately
            fetch(`${SM8_BASE}/job/${jobUuid}.json`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            }).catch(() => {});
          }
        }
      } catch (err) {
        fail('create_jobs_scope', err.message);
      }
    }
  }

  // ── REQ-On-46: company_uuid not blank (Make M3) ───────────────────────────
  // Cannot be asserted without executing the Make scenario. Document as handoff.
  // BUG-25: M3 expression reverts on UI save — never open prod scenario (5537814) in Make UI.
  skip('company_uuid', 'requires Make scenario execution — verify M3 expression via blueprint GET (REQ-On-58/BUG-25)');

  // ── REQ-On-47: PDF + two-step SM8 Attachment API ─────────────────────────
  // Requires publish_job_attachments scope (added with manage_jobs + read_attachments for RFT-32).
  // Until re-auth with updated scope string, fails at Attachment.json with 403.
  if (!destructive) {
    skip('pdf_attach', 'destructive=false — skipped for production clients per REQ-On-45');
  } else if (!env.PDF_WORKER) {
    skip('pdf_attach', 'PDF_WORKER service binding not configured — redeploy admin-api');
  } else {
    const freshRaw2 = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid);
    const freshRecord2 = freshRaw2 ? JSON.parse(freshRaw2) : null;
    const pdfToken = freshRecord2?.access_token;
    if (!pdfToken) {
      fail('pdf_attach', 'access_token missing — complete SM8 OAuth first (REQ-On-36)');
    } else {
      let pdfJobUuid = null;
      try {
        // Step 1: generate minimal test PDF via Service Binding (W2W — cannot use workers.dev URL)
        // RFT-87 scope (a): /generate now requires auth on both modes. Pass
        // Bearer RAFTER_WORKER_SECRET so pdf's requireFormJWT bypasses the
        // JWT path for this trusted internal call.
        const pdfReq = new Request('https://rafter-pdf.will-8e8.workers.dev/generate?mode=preview', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.RAFTER_WORKER_SECRET}`,
          },
          body: JSON.stringify({
            client_uuid: uuid,
            client_name: 'Smoketest',
            site_address: '1 Test St, Melbourne VIC 3000',
            proposal_type: 'LC',
            proposal_date: new Date().toISOString().slice(0, 10),
            quote_ref: `Q-SMOKETEST-${uuid.slice(0, 8)}`,
            total: 0,
            sections: [{ name: 'Test Section', items: [{ name: 'Smoketest item', price: 0, scope: 'Auto-generated smoketest — delete if found' }] }],
            form_sections: [], payment_schedule: [], payment_notes: '', lineItems: [],
          }),
        });
        const pdfRes = await env.PDF_WORKER.fetch(pdfReq);
        if (!pdfRes.ok) {
          fail('pdf_attach', `rafter-pdf /generate returned ${pdfRes.status}: ${(await pdfRes.text()).slice(0, 200)}`);
        } else {
          const pdfBytes = await pdfRes.arrayBuffer();
          // Step 2: create a test SM8 job to attach to
          const jobRes = await fetch(`${SM8_BASE}/job.json`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${pdfToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'Quote', job_description: `[Rafter pdf_attach smoketest ${uuid.slice(0, 8)} — auto-delete]` }),
          });
          if (!jobRes.ok) {
            fail('pdf_attach', `SM8 POST /job.json returned ${jobRes.status}`);
          } else {
            pdfJobUuid = jobRes.headers.get('x-record-uuid'); // VER-03
            if (!pdfJobUuid) {
              fail('pdf_attach', 'x-record-uuid header absent from SM8 job response (VER-03)');
            } else {
              // Step 3: create attachment record (requires publish_job_attachments scope)
              const attachRes = await fetch(`${SM8_BASE}/Attachment.json`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${pdfToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  related_object_uuid: pdfJobUuid, related_object: 'job',
                  attachment_type: 'document', name: `smoketest-${uuid.slice(0, 8)}.pdf`, mime_type: 'application/pdf',
                }),
              });
              if (attachRes.status === 403) {
                fail('pdf_attach', 'SM8 /Attachment.json → 403: publish_job_attachments scope missing. Re-auth via setup.html after adding scope to the string (RFT-32).');
              } else if (!attachRes.ok) {
                fail('pdf_attach', `SM8 POST /Attachment.json returned ${attachRes.status}`);
              } else {
                const attachUuid = attachRes.headers.get('x-record-uuid');
                if (!attachUuid) {
                  fail('pdf_attach', 'x-record-uuid absent from SM8 Attachment response');
                } else {
                  // Step 4: upload PDF binary
                  const uploadForm = new FormData();
                  uploadForm.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), `smoketest-${uuid.slice(0, 8)}.pdf`);
                  const uploadRes = await fetch(`${SM8_BASE}/Attachment/${attachUuid}.file`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${pdfToken}` },
                    body: uploadForm,
                  });
                  if (!uploadRes.ok) {
                    fail('pdf_attach', `SM8 POST /Attachment/${attachUuid}.file returned ${uploadRes.status}`);
                  } else {
                    pass('pdf_attach', { job_uuid: pdfJobUuid, attach_uuid: attachUuid, pdf_bytes: pdfBytes.byteLength });
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        fail('pdf_attach', err.message);
      } finally {
        if (pdfJobUuid) {
          fetch(`${SM8_BASE}/job/${pdfJobUuid}.json`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${pdfToken}` },
          }).catch(() => {});
        }
      }
    }
  }

  // ── REQ-On-48: Clerk org binding ─────────────────────────────────────────
  // Full JWT admission check deferred to Clerk wiring step. Check field presence now.
  {
    if (!record.clerk_org_id) {
      fail('clerk_org_binding', 'clerk_org_id not set in KV — complete Clerk onboarding flow first');
    } else {
      pass('clerk_org_binding', { clerk_org_id: record.clerk_org_id });
    }
  }

  // ── Payment thresholds shape ──────────────────────────────────────────────
  // index.html parseSplit() requires slash-delimited strings e.g. "50/50", not arrays or empty object.
  {
    const pt = record.payment_thresholds;
    const TIERS = ['under_20k','20k_to_35k','35k_to_50k','50k_to_100k','100k_to_200k','over_200k'];
    if (!pt || typeof pt !== 'object' || Object.keys(pt).length === 0) {
      fail('payment_thresholds_shape', 'payment_thresholds is missing or empty — quoting form cannot render payment schedule');
    } else {
      const badTiers = TIERS.filter(t => {
        const v = pt[t];
        if (!v) return true;
        if (Array.isArray(v)) return true; // should have been normalised — onboarding bug
        if (typeof v !== 'string' || !v.includes('/')) return true;
        return false;
      });
      if (badTiers.length) {
        fail('payment_thresholds_shape', `tiers with wrong format (expected "50/50" strings): ${badTiers.join(', ')}`);
      } else {
        pass('payment_thresholds_shape', { tiers: Object.keys(pt).length });
      }
    }
  }

  // ── Templates present ─────────────────────────────────────────────────────
  {
    const t = record.templates;
    if (!Array.isArray(t) || t.length === 0) {
      fail('templates_present', 'templates array is empty — quote form scope/description builder will have no options');
    } else {
      const malformed = t.filter(item => !item.name || !item.text).length;
      if (malformed) {
        fail('templates_present', `${malformed} of ${t.length} templates are missing name or text fields`);
      } else {
        pass('templates_present', { count: t.length });
      }
    }
  }

  // ── Email template present ────────────────────────────────────────────────
  {
    const et = record.email_template;
    if (!et || typeof et !== 'string' || et.trim().length === 0) {
      fail('email_template_present', 'email_template is empty — Make /render-email will return blank email HTML');
    } else {
      const hasMergeFields = et.includes('{client_name}') && et.includes('{job_address}');
      if (!hasMergeFields) {
        fail('email_template_present', 'email_template missing {client_name} or {job_address} merge fields — email will lack customer details');
      } else {
        pass('email_template_present', { length: et.length });
      }
    }
  }

  // ── Bank details present ──────────────────────────────────────────────────
  {
    const bd = record.bank_details;
    if (!bd || typeof bd !== 'object' || (!bd.name && !bd.bsb && !bd.account)) {
      fail('bank_details_present', 'bank_details empty — PDF will not render payment section (rafter-pdf checks bank_details.name/bsb/account)');
    } else {
      const missing = ['name','bsb','account'].filter(k => !bd[k]);
      if (missing.length) {
        fail('bank_details_present', `bank_details missing fields: ${missing.join(', ')}`);
      } else {
        pass('bank_details_present', { bank_name: bd.name });
      }
    }
  }

  // ── Staff UUID present ────────────────────────────────────────────────────
  {
    if (!record.staff_uuid) {
      fail('staff_uuid_present', 'staff_uuid is empty — Make will assign jobs to no staff member; set via setup.html OAuth callback picker');
    } else {
      pass('staff_uuid_present', { staff_uuid: record.staff_uuid });
    }
  }

  // ── REQ-On-49: Subscription gate live ────────────────────────────────────
  if (!env.CLERK_SECRET_KEY) {
    skip('subscription_gate', 'CLERK_SECRET_KEY not set on this Worker');
  } else if (!record.clerk_org_id) {
    fail('subscription_gate', 'clerk_org_id not set in KV — complete Clerk onboarding flow first');
  } else {
    try {
      const res = await fetch(`https://api.clerk.com/v1/organizations/${record.clerk_org_id}`, {
        headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
      });
      if (res.status === 404) {
        fail('subscription_gate', `Clerk org ${record.clerk_org_id} not found — may have been deleted`);
      } else if (!res.ok) {
        fail('subscription_gate', `Clerk API returned ${res.status}`);
      } else {
        // Test keys: org existence is sufficient (Clerk Billing not active in test mode).
        // Production keys: TODO add subscription state check when Clerk Billing is activated.
        pass('subscription_gate', {
          clerk_org_id: record.clerk_org_id,
          billing_check: env.CLERK_SECRET_KEY.startsWith('sk_test_') ? 'deferred (test mode)' : 'deferred (billing not yet activated)',
        });
      }
    } catch (err) {
      fail('subscription_gate', `Clerk API error: ${err.message}`);
    }
  }

  // ── REQ-On-52: structured result — done (this object is the result) ───────

  // ── REQ-On-53: on overall pass, flip Clerk metadata + log D1 event ───────
  const nonSkipped = Object.entries(assertions).filter(([, v]) => v.passed !== null);
  const hardPassed = nonSkipped.every(([, v]) => v.passed);

  if (hardPassed) {
    await writeEvent(env, 'onboarding_completed', uuid, { skipped_assertions: Object.keys(assertions).filter(k => assertions[k].skipped) });
    // REQ-On-53: flip Clerk public metadata so the edge JWT check admits the client to the quoting form
    if (env.CLERK_SECRET_KEY && record?.clerk_org_id) {
      try {
        await fetch(`https://api.clerk.com/v1/organizations/${record.clerk_org_id}/metadata`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ public_metadata: { rafter_onboarding_complete: true } }),
        });
      } catch (err) {
        console.error(JSON.stringify({ event: 'clerk_metadata_flip_error', uuid, error: err.message }));
      }
    }
    console.log(JSON.stringify({ event: 'smoketest_passed', uuid }));
  } else {
    console.log(JSON.stringify({ event: 'smoketest_failed', uuid }));
  }

  return { passed: hardPassed, uuid, destructive, assertions };
}

// ── SM8 prefill — onboarding connect-first flow ──────────────────────────────
// Called GET /onboarding/sm8-prefill (Clerk JWT scoped to org).
// Resolves org → uuid → KV, refreshes SM8 token via materials-sync,
// then fetches vendor.json + jobtemplate.json from SM8. Returns structured prefill data.
async function handleSm8Prefill(jwtPayload, env) {
  const orgId = extractOrgId(jwtPayload) ?? null;
  if (!orgId) return json({ ok: false, error: 'No org_id in JWT — organisation context required' }, 400);

  const uuid = await env.RAFTER_CLIENTS.get('clerk_org:' + orgId).catch(() => null);
  if (!uuid) return json({ ok: false, error: 'No client record found for this organisation' }, 404);

  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) return json({ ok: false, error: 'Client record not found in KV' }, 404);

  const record = JSON.parse(raw);
  if (!record.access_token) {
    return json({ ok: false, error: 'ServiceM8 not connected — complete OAuth before prefill', code: 'NO_TOKEN' }, 422);
  }

  // Refresh token via materials-sync (side effect: also syncs materials — fine for onboarding)
  try {
    const syncRes = await syncFetch(env, `/refresh-materials?uuid=${uuid}`);
    if (!syncRes.ok) {
      const detail = await syncRes.text().catch(() => String(syncRes.status));
      return json({ ok: false, error: `Token refresh failed: ${detail.slice(0, 200)}`, code: 'REFRESH_FAILED' }, 422);
    }
  } catch (err) {
    return json({ ok: false, error: `Token refresh error: ${err.message}`, code: 'REFRESH_FAILED' }, 502);
  }

  // Re-read KV to get fresh token after refresh
  const freshRaw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  const freshRecord = freshRaw ? JSON.parse(freshRaw) : record;
  const token = freshRecord.access_token;

  try {
    const [vendorRes, templateRes, staffRes] = await Promise.all([
      fetch(`${SM8_BASE}/vendor.json`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${SM8_BASE}/jobtemplate.json?$filter=active eq 1`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${SM8_BASE}/staff.json`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);

    const vendorBody = vendorRes.ok ? await vendorRes.json().catch(() => null) : null;
    const templatesBody = templateRes.ok ? await templateRes.json().catch(() => []) : [];
    const staffBody = staffRes.ok ? await staffRes.json().catch(() => []) : [];

    // vendor.json may be array-wrapped or a single object depending on SM8 version
    const v = Array.isArray(vendorBody) ? (vendorBody[0] ?? {}) : (vendorBody ?? {});

    const sections = Array.isArray(templatesBody)
      ? templatesBody.filter(t => t.active !== 0 && t.name).map(t => ({ name: t.name }))
      : [];

    // staff.json: filter active, combine first + last into display name
    const staff = Array.isArray(staffBody)
      ? staffBody
          .filter(s => s && s.active != 0)
          .map(s => ({ uuid: s.uuid, name: [s.first, s.last].filter(Boolean).join(' ') }))
      : [];

    return json({
      ok: true,
      uuid,
      vendor: {
        company_name: v.name ?? '',
        abn: v.abn_number ?? '',       // SM8 field is abn_number, not abn
        business_email: '',             // v.email is a ServiceM8 relay addr, not business contact
        business_address: v.billing_address ?? '',  // SM8 field is billing_address, not address
      },
      sections,
      staff,
    });
  } catch (err) {
    return json({ ok: false, error: `SM8 fetch failed: ${err.message}` }, 502);
  }
}

// ── ABN live lookup — Track C (RFT-53) ──────────────────────────────────────
// Proxies ABR SimpleProtocol to keep ABR_GUID server-side.
// Returns checksum_only mode when ABR_GUID is unset — form stays functional pre-GUID.
// Source: abr.business.gov.au/Documentation/WebServiceMethods (SearchByABNv202001 HTTP GET)
async function handleAbnLookup(url, env) {
  const abn = (url.searchParams.get('abn') ?? '').replace(/\D/g, '');
  if (abn.length !== 11) return json({ ok: false, error: 'abn must be 11 digits' }, 400);

  if (!env.ABR_GUID) {
    return json({ ok: true, mode: 'checksum_only', detail: 'ABR_GUID not set — set secret to enable live lookup' });
  }

  try {
    const abrUrl = 'https://abr.business.gov.au/abrxmlsearch/AbrXmlSearch.asmx/SearchByABNv202001' +
      `?searchString=${abn}&includeHistoricalDetails=N&authenticationGuid=${encodeURIComponent(env.ABR_GUID)}`;
    const res = await fetch(abrUrl, { headers: { Accept: 'application/xml' } });
    if (!res.ok) return json({ ok: false, error: `ABR service returned ${res.status}` }, 502);
    const xml = await res.text();
    return json({ ok: true, ...parseAbrXml(xml) });
  } catch (err) {
    return json({ ok: false, error: `ABR lookup failed: ${err.message}` }, 502);
  }
}

function parseAbrXml(xml) {
  // ABR SimpleProtocol v202001 XML response — regex extraction (structure is stable)
  // Source: abr.business.gov.au/Documentation/WebServiceResponse
  const exception = xml.match(/<exceptionDescription>([^<]+)<\/exceptionDescription>/)?.[1];
  if (exception) return { valid: false, reason: exception };

  const statusCode = xml.match(/<entityStatusCode>([^<]+)<\/entityStatusCode>/)?.[1] ?? 'Unknown';
  const orgName    = xml.match(/<organisationName>([^<]+)<\/organisationName>/)?.[1] ?? null;
  const givenName  = xml.match(/<givenName>([^<]+)<\/givenName>/)?.[1] ?? null;
  const familyName = xml.match(/<familyName>([^<]+)<\/familyName>/)?.[1] ?? null;
  const entityName = orgName ?? ([givenName, familyName].filter(Boolean).join(' ') || null);

  return { valid: statusCode === 'Active', entityName, entityStatus: statusCode };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Call materials-sync via Service Binding (preferred — avoids workers.dev subrequest routing issues)
// Falls back to HTTP fetch if binding not configured (local dev, partial deploys)
function syncFetch(env, path) {
  const url = `${MATERIALS_SYNC}${path}`;
  const headers = env.RAFTER_WORKER_SECRET ? { Authorization: `Bearer ${env.RAFTER_WORKER_SECRET}` } : {};
  if (env.MATERIALS_SYNC_WORKER) {
    return env.MATERIALS_SYNC_WORKER.fetch(new Request(url, { headers }));
  }
  return fetch(url, { headers });
}

async function writeEvent(env, event_type, client_uuid, payload) {
  if (!env.RAFTER_EVENTS) return;
  try {
    await env.RAFTER_EVENTS.prepare(
      'INSERT INTO events (id, event_type, client_uuid, occurred_at, payload) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      event_type,
      client_uuid,
      new Date().toISOString(),
      JSON.stringify(payload ?? {})
    ).run();
  } catch (err) {
    console.error(JSON.stringify({ event: 'd1_write_error', error: err.message }));
  }
}

function base64ToBytes(b64) {
  const binary = atob(b64.replace(/^data:[^;]+;base64,/, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function parseBody(request) {
  try { return await request.json(); } catch { return null; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
