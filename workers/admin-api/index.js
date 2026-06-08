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

// Allow onboarding.html (rafter.deepgreensea.au) to call this worker cross-origin.
// Any endpoint that onboarding.html fetches with an Authorization header requires
// a CORS preflight — OPTIONS must return 204 with the allow headers, and the real
// response must include Access-Control-Allow-Origin.
const CORS_ORIGIN = 'https://rafter.deepgreensea.au';
const CORS_PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function withCors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  return r;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight — must be handled before any auth check
    if (request.method === 'OPTIONS' && (pathname.startsWith('/onboarding/') || pathname.startsWith('/form/') || pathname.startsWith('/settings/'))) {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
    }

    if (request.method === 'POST' && pathname === '/webhooks/clerk') {
      return handleClerkWebhook(request, env);
    }
    if (pathname.startsWith('/admin/')) {
      const authErr = requireBearer(request, env);
      if (authErr) return authErr;
      return handleAdmin(request, env, url);
    }
    if ((request.method === 'POST' || request.method === 'GET') && pathname.startsWith('/onboarding/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error);
      return withCors(await handleOnboarding(request, env, url, payload));
    }
    // RFT-87 commit 7: public tenant-mode lookup. Form calls this BEFORE
    // knowing whether to demand a Clerk session — answer comes from the
    // per-tenant gate_enforced flag. No auth. Resolves slug→uuid as a
    // side-effect (replaces the retired /resolve-slug function).
    const tenantModeMatch = request.method === 'GET' && pathname.match(/^\/form\/tenant-mode\/([a-z0-9-]+)$/i);
    if (tenantModeMatch) {
      return withCors(await handleTenantMode(tenantModeMatch[1], env));
    }
    // RFT-87 scope (a): /form/* is the verification surface other workers
    // proxy form requests through. Same Clerk-JWT auth as /onboarding/*; the
    // distinction is purpose — /onboarding is for the onboarding flow itself,
    // /form is for runtime tenant-ownership verification from the operator form.
    if ((request.method === 'POST' || request.method === 'GET') && pathname.startsWith('/form/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error);
      return withCors(await handleForm(request, env, url, payload));
    }
    // RFT-63: /settings/* is the post-onboarding tenant config surface. Same
    // Clerk-JWT gate as /onboarding/*, plus an org:admin role requirement at
    // the handler layer (per RFT-63 decision — start closed, loosen later).
    if (pathname.startsWith('/settings/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return withCors(error);
      return withCors(await handleSettings(request, env, url, payload));
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
    const payload = await verifyToken(token, {
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: env.CLERK_AUTHORIZED_PARTY ? [env.CLERK_AUTHORIZED_PARTY] : undefined,
    });
    return { payload };
  } catch {
    return { error: json({ ok: false, error: 'Invalid token' }, 401) };
  }
}

// RFT-70 Option C — Clerk org-role extraction. Handles both Clerk JWT formats:
// v1 (legacy, flat `org_role` claim) and v2 (compact `o.rol` object, default
// since 2025-04-14). Returns the role string (e.g. "org:admin", "org:member")
// or null if no org context. Clerk's @clerk/backend verifyToken passes the
// payload through unmodified, so we have to handle both shapes ourselves.
function extractOrgRole(jwtPayload) {
  if (typeof jwtPayload?.org_role === 'string') return jwtPayload.org_role;
  if (typeof jwtPayload?.o?.rol === 'string') return jwtPayload.o.rol;
  return null;
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
    // Scope to JWT org — browser cannot provision outside its own org (REQ-On-28)
    body.clerk_org_id = jwtPayload.org_id ?? null;
    return handleProvision(body, env);
  }

  if (method === 'POST' && path === '/onboarding/verify') {
    const body = await parseBody(request) ?? {};
    const uuid = body.uuid;
    if (!uuid) return json({ ok: false, error: 'uuid required in body' }, 400);
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
// Default: missing flag = ungated (false). Safe for tenants that exist
// today without a Clerk user (e.g. Andy on his current production setup).
// NOTE for follow-up: once the passkey/invite flow lands (scope b), the
// default semantics should flip — new tenants closed-by-default with the
// flag explicitly set by the provisioning flow. Until then, missing=ungated
// keeps the rollout safe.
async function handleTenantMode(slug, env) {
  if (!/^[a-z0-9-]+$/i.test(slug)) {
    return json({ ok: false, error: 'invalid_slug' }, 400);
  }
  const uuid = await env.RAFTER_CLIENTS.get(SLUG_PREFIX + slug).catch(() => null);
  if (!uuid) {
    return json({ ok: false, error: 'slug_not_found', slug }, 404);
  }
  const raw = await env.RAFTER_CLIENTS.get(CLIENT_PREFIX + uuid).catch(() => null);
  if (!raw) {
    return json({ ok: false, error: 'client_not_found', uuid }, 404);
  }
  let config;
  try { config = JSON.parse(raw); }
  catch { return json({ ok: false, error: 'client_record_corrupt' }, 500); }
  const gate_enforced = config.gate_enforced === true;
  return json({ ok: true, slug, uuid, gate_enforced });
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
  const orgId = jwtPayload.org_id;
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
    const slugUuid = await env.RAFTER_CLIENTS.get(`slug:${target_slug}`).catch(() => null);
    if (!slugUuid) {
      return json({ ok: false, error: 'slug_not_found', slug: target_slug }, 404);
    }
    resolvedTargetUuid = slugUuid;
  }

  // Cross-tenant check — the actual RFT-86 fix
  if (orgUuid !== resolvedTargetUuid) {
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
  const orgId = jwtPayload.org_id;
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
  if (method === 'POST' && path === '/settings/sections/sync')             return handleSettingsSectionsSync(uuid, env);

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
  // by /settings/sections/sync). Read-only prose per RFT-63 Q1.
  const sections = Array.isArray(record.templates) ? record.templates.map(t => ({
    name: t.name || '',
    text: t.text || '',
  })) : [];

  // Photos grouped by R2 category prefix, sorted by photo_order from the KV
  // record. Mirror handleListPhotos in materials-sync — same per-tenant key
  // shape (clients/<uuid>/photos/<cat>/<file>).
  const photoOrderMap = (record.photo_order && typeof record.photo_order === 'object') ? record.photo_order : {};
  const photos = await listPhotosByCategory(uuid, env, photoOrderMap);

  return json({
    ok: true,
    uuid,
    company_name: record.company_name || '',
    slug: record.slug || '',
    sections,
    photos,
  });
}

async function listPhotosByCategory(uuid, env, photoOrderMap = {}) {
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
  // For each category: sort by photo_order if set, then any keys not in the
  // order list go to the end alphabetically (covers fresh uploads + legacy
  // photos uploaded before order persistence existed).
  return [...categories.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
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
  if (!key.startsWith(prefix)) return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);
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
  if (!fromKey.startsWith(prefix)) return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);

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
  if (!fromKey.startsWith(prefix)) return json({ ok: false, error: 'cross_tenant_forbidden' }, 403);

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
  if (scoped.length !== keys.length) return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);

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
  if (scoped.length !== keys.length) return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);
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
  if (scoped.length !== keys.length) return json({ ok: false, error: 'cross_tenant_forbidden', detail: 'some keys outside tenant scope' }, 403);
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

  // Safeguard: SM8 came back empty while Rafter has templates. Almost
  // certainly a token blip or OAuth misconfig on SM8's side. Refuse rather
  // than wipe the tenant on one bad response.
  if (activeTemplates.length === 0 && existing.length > 0) {
    return json({
      ok: false,
      error: 'sm8_returned_empty_with_existing_local',
      code: 'EMPTY_SM8_REFUSE_WIPE',
      detail: `SM8 reported 0 active templates but Rafter has ${existing.length}. Refusing to wipe. Re-check the SM8 OAuth grant and retry.`,
    }, 502);
  }

  // First-run uuid backfill: any Rafter entry without sm8_template_uuid
  // gets matched to an SM8 entry by name. One-time migration from
  // name-keyed to uuid-keyed identity. After this, uuid alone drives the
  // diff — including rename detection.
  const sm8ByName = new Map(activeTemplates.map(t => [t.name.trim(), t]));
  for (const entry of existing) {
    if (!entry.sm8_template_uuid) {
      const match = sm8ByName.get((entry.name || '').trim());
      if (match) entry.sm8_template_uuid = match.uuid;
    }
  }

  const existingByUuid = new Map();
  for (const entry of existing) {
    if (entry.sm8_template_uuid) existingByUuid.set(entry.sm8_template_uuid, entry);
  }

  // Diff
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
  const toRemove = existing.filter(e => !e.sm8_template_uuid || !activeUuidSet.has(e.sm8_template_uuid));

  // Working copy that drops removed rows up front. Add/update mutate the
  // surviving rows in place; ADD appends new rows. Writes back at the end.
  const survivors = existing.filter(e => !toRemove.includes(e));

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
    for (const sm8Tpl of toAdd) {
      let prose;
      try { prose = await cloneReadProse(token, sm8Tpl.uuid, createdJobUuids); }
      catch (err) { failed.push({ name: sm8Tpl.name, step: err.step || 'add', detail: err.message }); continue; }
      survivors.push({
        name: sm8Tpl.name,
        text: prose,
        sm8_edit_date: sm8Tpl.edit_date || '',
        sm8_template_uuid: sm8Tpl.uuid,
      });
      added.push(sm8Tpl.name);
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
  const orgId = jwtPayload.org_id;
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
  const orgId = jwtPayload.org_id;
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
  const orgId = jwtPayload.org_id;
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
  if (!body.slug) errors.push('slug required');
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
  const orgId = jwtPayload.org_id ?? null;
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
