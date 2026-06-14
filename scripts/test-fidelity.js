#!/usr/bin/env node
// scripts/test-fidelity.js — RFT-40 round-trip + finder-filter fidelity tests
//
// Exercises the rafter-quotes D1 persistence layer end-to-end against the BVT
// test tenant (df902850-…). Uses only Node 20+ built-ins (global fetch). No npm
// install required.
//
// COVERAGE THIS SCRIPT
//   Test 1 — Draft round-trip: POST /store-draft, GET /draft/{ref}, deep-equal
//            the payload (server adds created_at/updated_at; those are
//            ignored). Proves "save → fetch is lossless" for drafts.
//   Test 2 — Finder filter exclusion: a draft created in Test 1 must NOT
//            appear in /drafts (default 'submitted' filter) and MUST appear
//            in /drafts?status=draft. Proves the boot-time resume banner
//            doesn't bleed into the operator finder and vice versa.
//   Test 3 — Status-gated delete: DELETE /draft/{ref} removes the row;
//            subsequent GET returns 404. Confirms the status='draft' WHERE
//            clause permits delete on a draft row.
//
// COVERAGE DEFERRED (requires Make/SM8 integration — track separately)
//   * Submit round-trip via /generate?mode=submit + Make callback —
//     async + creates a real SM8 job on BVT. Test as a manual checklist
//     until a way to safely seed a 'submitted' row exists.
//   * Amend chain (v1 → v2 with parent_ref/superseded/sm8_job_uuid stable) —
//     requires an existing real SM8 job; can't be seeded from the test
//     script without side effects.
//   * Multiple-attachment safety (RFT-33) + job_description append (RFT-34) —
//     same SM8 dependency.
//
// AUTH
//   The script uses the x-rafter-secret bypass (RAFTER_INTERNAL_SECRET) on
//   materials-sync's requireFormJWT. This is the same secret already used by
//   the worker for legitimate internal calls; no new prod secret is created.
//   Provide via env var (RAFTER_INTERNAL_SECRET) or place the value in a
//   file at scripts/.test-secret (gitignored). Without it the script exits
//   with a clear error before any HTTP call.
//
// USAGE
//   $env:RAFTER_INTERNAL_SECRET = '...'
//   node scripts/test-fidelity.js
//
//   # or, file-based:
//   echo -n '...' > scripts/.test-secret
//   node scripts/test-fidelity.js

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BVT_UUID = process.env.BVT_UUID || 'df902850-7e48-4e7a-8f2c-b3a65b6881da';
const MATERIALS_SYNC = process.env.MATERIALS_SYNC_URL || 'https://rafter-materials-sync.will-8e8.workers.dev';

function loadSecret() {
  if (process.env.RAFTER_INTERNAL_SECRET) return process.env.RAFTER_INTERNAL_SECRET;
  const filePath = path.join(__dirname, '.test-secret');
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    // Allow either the bare secret or a PowerShell-style assignment line.
    const m = raw.match(/'([^']+)'/);
    return m ? m[1] : raw;
  }
  return null;
}

const SECRET = loadSecret();
if (!SECRET) {
  console.error('ERROR: RAFTER_INTERNAL_SECRET not found.');
  console.error('Provide via env var or place the value in scripts/.test-secret');
  process.exit(2);
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const COLOR = process.stdout.isTTY ? {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
} : { green: (s) => s, red: (s) => s, dim: (s) => s };

function generateQuoteRef() {
  // Q-YYYYMMDD-HHMM (script local time — BVT tests don't care about Melbourne TZ)
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Q-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function uniqueQuoteRef() {
  // Add a per-run suffix so re-running back-to-back doesn't collide.
  const base = generateQuoteRef();
  const suffix = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  return `${base.slice(0, -2)}${suffix}`;
}

async function call(method, pathStr, { body, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${MATERIALS_SYNC}${pathStr}${qs}`;
  const headers = { 'x-rafter-secret': SECRET };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

// Deep equality with key-sort and selective field omission. Returns
// { equal, diffPath } so the caller can pinpoint the first divergence.
const SERVER_ONLY_KEYS = new Set(['created_at', 'updated_at']);
function deepEqual(a, b, p = '') {
  if (a === b) return { equal: true };
  if (a == null || b == null || typeof a !== typeof b) {
    return { equal: false, diffPath: p, a, b };
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return { equal: false, diffPath: p, a, b };
    for (let i = 0; i < a.length; i++) {
      const r = deepEqual(a[i], b[i], `${p}[${i}]`);
      if (!r.equal) return r;
    }
    return { equal: true };
  }
  if (typeof a === 'object') {
    const aks = Object.keys(a).filter(k => !SERVER_ONLY_KEYS.has(k)).sort();
    const bks = Object.keys(b).filter(k => !SERVER_ONLY_KEYS.has(k)).sort();
    if (aks.length !== bks.length || aks.some((k, i) => k !== bks[i])) {
      return { equal: false, diffPath: p, a_keys: aks, b_keys: bks };
    }
    for (const k of aks) {
      const r = deepEqual(a[k], b[k], p ? `${p}.${k}` : k);
      if (!r.equal) return r;
    }
    return { equal: true };
  }
  return { equal: false, diffPath: p, a, b };
}

function buildSamplePayload() {
  return {
    quote_ref: '__will_be_overwritten__',
    client_uuid: BVT_UUID,
    proposal_type: 'LC',
    proposal_date: '2026-06-14',
    client_name: 'RFT-40 Test Customer',
    customer_email: 'rft40@example.test',
    customer_phone: '0400 000 000',
    site_address: '1 Test Street, Brunswick VIC 3056',
    notes: 'Round-trip fidelity sample — safe to delete.',
    form_sections: [
      {
        name: 'Test Section A',
        price: 1500,
        text: 'Sample scope text for section A.',
        line_items: [
          { name: 'Labour', quantity: 8, unit: 'hr', unit_price: 95, total: 760, sm8_uuid: null },
          { name: 'Materials', quantity: 1, unit: 'lot', unit_price: 740, total: 740, sm8_uuid: null },
        ],
        photos: ['clients/df902850-7e48-4e7a-8f2c-b3a65b6881da/photos/__misc__/test-1.jpg'],
      },
      {
        name: 'Test Section B',
        price: 500,
        text: 'Second section to verify multi-section persistence.',
        line_items: [],
        photos: [],
      },
    ],
    subtotal: 2000,
    gst: 200,
    total: 2200,
    payment_schedule: [
      { percentage: 50, description: 'Deposit', amount: 1100 },
      { percentage: 50, description: 'On completion', amount: 1100 },
    ],
    bank_details: { name: 'Test Bank', bsb: '000-000', account: '12345678' },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];

function reportTest(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ${COLOR.green('✓')} ${name}`);
    if (detail) console.log(`    ${COLOR.dim(detail)}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  ${COLOR.red('✗')} ${name}`);
    if (detail) console.log(`    ${COLOR.red(detail)}`);
  }
}

async function testDraftRoundTrip() {
  console.log('\nTest 1 — Draft round-trip fidelity');
  const ref = uniqueQuoteRef();
  const payload = buildSamplePayload();
  payload.quote_ref = ref;

  // Save.
  const save = await call('POST', '/store-draft', { body: { quote_ref: ref, client_uuid: BVT_UUID, payload } });
  if (!save.ok) return reportTest('save draft', false, `POST /store-draft → ${save.status} ${JSON.stringify(save.json).slice(0, 200)}`) || ref;
  reportTest('save draft', true, `quote_ref=${ref} updated_at=${save.json.updated_at}`);

  // Fetch.
  const fetched = await call('GET', `/draft/${encodeURIComponent(ref)}`, { query: { client_uuid: BVT_UUID } });
  if (!fetched.ok) return reportTest('fetch draft', false, `GET /draft/{ref} → ${fetched.status}`) || ref;
  reportTest('fetch draft', true, `status=${fetched.json.status}`);

  // Verify status forced to 'draft' regardless of input.
  reportTest('status is "draft"', fetched.json.status === 'draft', `actual: ${fetched.json.status}`);

  // Verify sm8_job_uuid forced to null.
  reportTest('sm8_job_uuid is null', fetched.json.sm8_job_uuid == null, `actual: ${JSON.stringify(fetched.json.sm8_job_uuid)}`);

  // Verify version is 1 and parent_ref null (draft invariants).
  reportTest('version === 1', fetched.json.version === 1, `actual: ${fetched.json.version}`);
  reportTest('parent_ref === null', fetched.json.parent_ref == null, `actual: ${JSON.stringify(fetched.json.parent_ref)}`);

  // Deep-equal the payload (server doesn't mutate it).
  const eq = deepEqual(payload, fetched.json.payload);
  if (!eq.equal) {
    reportTest('payload deep-equal', false, `diverged at: ${eq.diffPath}  a=${JSON.stringify(eq.a).slice(0, 100)}  b=${JSON.stringify(eq.b).slice(0, 100)}`);
  } else {
    reportTest('payload deep-equal', true, `${Object.keys(payload).length} keys verified, no diff`);
  }
  return ref;
}

async function testFinderFilter(ref) {
  console.log('\nTest 2 — Finder filter exclusion');

  // Default (submitted) → ref MUST NOT appear. The default path also runs
  // the RFT-85 SM8 liveness check, so a stale-token tenant returns 502
  // here regardless of fidelity — treat that as "skipped, env issue" so
  // the status=draft branch (which skips liveness) still gets exercised.
  const submittedList = await call('GET', '/drafts', { query: { client_uuid: BVT_UUID } });
  if (submittedList.status === 502) {
    console.log(`  ${COLOR.dim('• GET /drafts default skipped — 502, BVT SM8 token likely expired (RFT-85 liveness check)')}`);
  } else if (!submittedList.ok) {
    reportTest('GET /drafts default', false, `${submittedList.status} ${JSON.stringify(submittedList.json).slice(0, 200)}`);
  } else {
    reportTest('GET /drafts default', true, `count=${submittedList.json.count ?? (submittedList.json.results || []).length}`);
    const submittedResults = submittedList.json.results || [];
    const submittedHas = submittedResults.some(r => r.quote_ref === ref);
    reportTest('draft NOT in default finder', !submittedHas, submittedHas ? `unexpected: ref ${ref} present in default list (would bleed into operator finder)` : `confirmed absent`);
  }

  // status=draft → ref MUST appear. Liveness check is skipped server-side
  // for the draft branch so this works even when the default 502s.
  const draftList = await call('GET', '/drafts', { query: { client_uuid: BVT_UUID, status: 'draft' } });
  if (!draftList.ok) return reportTest('GET /drafts?status=draft', false, `${draftList.status} ${JSON.stringify(draftList.json).slice(0, 200)}`);
  reportTest('GET /drafts?status=draft', true, `count=${draftList.json.count ?? (draftList.json.results || []).length}`);
  const draftResults = draftList.json.results || [];
  const draftHas = draftResults.some(r => r.quote_ref === ref);
  reportTest('draft present in ?status=draft', draftHas, draftHas ? `confirmed present` : `MISSING: ref ${ref} not in draft list (resume banner would not find it)`);
}

async function testStatusGatedDelete(ref) {
  console.log('\nTest 3 — Status-gated delete');

  const del = await call('DELETE', `/draft/${encodeURIComponent(ref)}`, { query: { client_uuid: BVT_UUID } });
  reportTest('DELETE /draft/{ref}', del.ok, del.ok ? `deleted=${del.json.deleted}` : `status=${del.status} body=${JSON.stringify(del.json).slice(0, 200)}`);

  // Verify subsequent fetch 404s.
  const after = await call('GET', `/draft/${encodeURIComponent(ref)}`, { query: { client_uuid: BVT_UUID } });
  reportTest('subsequent GET → 404', after.status === 404, `actual: ${after.status}`);

  // Verify a second DELETE returns 404 (idempotency check — proves the
  // status='draft' WHERE clause stays effective on an empty result set).
  const del2 = await call('DELETE', `/draft/${encodeURIComponent(ref)}`, { query: { client_uuid: BVT_UUID } });
  reportTest('second DELETE → 404 (idempotent)', del2.status === 404, `actual: ${del2.status}`);
}

async function cleanup(ref) {
  // Belt-and-braces — if Test 3 was skipped due to a Test 1/2 failure, clean
  // up the draft so re-runs aren't polluted.
  if (!ref) return;
  await call('DELETE', `/draft/${encodeURIComponent(ref)}`, { query: { client_uuid: BVT_UUID } }).catch(() => {});
}

// ───────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('RFT-40 fidelity tests');
  console.log(`  target  ${MATERIALS_SYNC}`);
  console.log(`  tenant  BVT (${BVT_UUID})`);
  console.log(`  auth    x-rafter-secret (${SECRET.slice(0, 4)}…${SECRET.slice(-2)})`);

  let ref;
  try {
    ref = await testDraftRoundTrip();
    if (ref) await testFinderFilter(ref);
    if (ref) await testStatusGatedDelete(ref);
  } catch (e) {
    console.error(`\nUNCAUGHT: ${e.stack || e.message}`);
    fail++;
  } finally {
    await cleanup(ref);
  }

  console.log(`\n${pass + fail} checks · ${COLOR.green(`${pass} passed`)} · ${fail ? COLOR.red(`${fail} failed`) : `${fail} failed`}`);
  if (fail) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  process.exit(fail ? 1 : 0);
})();
