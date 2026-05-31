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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'POST' && pathname === '/webhooks/clerk') {
      return handleClerkWebhook(request, env);
    }
    if (pathname.startsWith('/admin/')) {
      const authErr = requireBearer(request, env);
      if (authErr) return authErr;
      return handleAdmin(request, env, url);
    }
    if (request.method === 'POST' && pathname.startsWith('/onboarding/')) {
      const { error, payload } = await requireClerkJWT(request, env);
      if (error) return error;
      return handleOnboarding(request, env, url, payload);
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
    // uuid from body or derive from clerk_org_id lookup (full impl at Clerk wiring step)
    const uuid = body.uuid;
    if (!uuid) return json({ ok: false, error: 'uuid required in body' }, 400);
    return handleVerify(uuid, url, env);
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

// ── Provisioning — REQ-On-29 to 34 ──────────────────────────────────────────

async function handleProvision(body, env) {
  const errors = [];
  if (!body.slug) errors.push('slug required');
  if (!body.company_name) errors.push('company_name required');
  if (!body.webhook_url) errors.push('webhook_url required');
  if (errors.length) return json({ ok: false, errors }, 400);

  try {
    const result = await provisionClient(body, env);
    return json({ ok: true, ...result });
  } catch (err) {
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
    email_template: '', clerk_org_id: null,
  };

  // REQ-On-29: build record — defaults → existing (preserves OAuth tokens etc.) → required body fields
  const record = { ...defaults, ...existing, uuid, slug, company_name: body.company_name, webhook_url: body.webhook_url, logo_url: `${MATERIALS_SYNC}/logo/${uuid}` };

  // Optional fields: only override if explicitly provided in body
  const OPTIONAL_FIELDS = ['phone','business_address','abn','business_email','operator_email',
    'payment_thresholds','proposal_types','job_categories','job_queues','templates',
    'credentials','terms_and_conditions','staff_uuid','email_template','clerk_org_id'];
  for (const f of OPTIONAL_FIELDS) {
    if (body[f] !== undefined) record[f] = body[f];
  }

  // REQ-On-29: write KV client record + slug resolver
  await env.RAFTER_CLIENTS.put(CLIENT_PREFIX + uuid, JSON.stringify(record));
  if (slug) await env.RAFTER_CLIENTS.put(SLUG_PREFIX + slug, uuid);
  // Clerk org reverse index: enables UUID continuity and idempotency checks
  if (record.clerk_org_id) await env.RAFTER_CLIENTS.put('clerk_org:' + record.clerk_org_id, uuid);
  // Clean up stale slug key if slug changed (e.g., Clerk slug replaced by admin slug on form submit)
  if (existing.slug && slug && existing.slug !== slug) {
    await env.RAFTER_CLIENTS.delete(SLUG_PREFIX + existing.slug).catch(() => {});
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
  // TODO: call rafter-pdf /generate?mode=preview, then POST /Attachment.json + /Attachment/{uuid}.file
  skip('pdf_attach', 'TODO: implement rafter-pdf + SM8 two-step Attachment API test');

  // ── REQ-On-48: Clerk org binding ─────────────────────────────────────────
  // Full JWT admission check deferred to Clerk wiring step. Check field presence now.
  {
    if (!record.clerk_org_id) {
      fail('clerk_org_binding', 'clerk_org_id not set in KV — complete Clerk onboarding flow first');
    } else {
      pass('clerk_org_binding', { clerk_org_id: record.clerk_org_id });
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
    // TODO REQ-On-53: flip Clerk public metadata to onboarding_complete — implement at Clerk wiring step
    console.log(JSON.stringify({ event: 'smoketest_passed', uuid }));
  } else {
    console.log(JSON.stringify({ event: 'smoketest_failed', uuid }));
  }

  return { passed: hardPassed, uuid, destructive, assertions };
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
