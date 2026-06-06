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
    if (request.method === 'OPTIONS' && pathname.startsWith('/onboarding/')) {
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

  return json({ ok: false, error: 'Not Found' }, 404);
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
        const pdfReq = new Request('https://rafter-pdf.will-8e8.workers.dev/generate?mode=preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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
