import puppeteer from "@cloudflare/puppeteer";
import { MULISH_400_TTF_B64, MULISH_700_TTF_B64, PLAYFAIR_600_LATIN_B64 } from "./fonts.js";

const COLORS = {
  ink: "#1a1a1a",
  scope: "#444",
  asterisk: "#999",
  body555: "#555",
  muted: "#666",
  rule: "#D0D0D0",
};

const PLATFORM_DEFAULTS = {
  primary:    "#2E86AB",
  accent:     "#1B4F72",
  background: "#EAF4F8",
};

const PRESETS = {
  "deep-green-sea": PLATFORM_DEFAULTS,
  "slate-copper":   { primary: "#B7410E", accent: "#2F3E46", background: "#F4F1ED" },
  "ink-amber":      { primary: "#1C1C1E", accent: "#E8A317", background: "#FAF8F4" },
  "oxblood":        { primary: "#6B0F1A", accent: "#1A1A1A", background: "#F5F0E8" },
  "terracotta":     { primary: "#C75B39", accent: "#3D405B", background: "#FFF8F0" },
};

function resolveBranding(branding) {
  const b = branding || {};
  const preset = (b.preset && PRESETS[b.preset]) ? PRESETS[b.preset] : null;
  return {
    primary:    b.primary    || (preset && preset.primary)    || PLATFORM_DEFAULTS.primary,
    accent:     b.accent     || (preset && preset.accent)     || PLATFORM_DEFAULTS.accent,
    background: b.background || (preset && preset.background) || PLATFORM_DEFAULTS.background,
  };
}

function buildProposalTypeLabels(proposalTypes) {
  const labels = {};
  if (!Array.isArray(proposalTypes)) return labels;
  for (const item of proposalTypes) {
    if (item && typeof item === 'object' && item.code) {
      labels[item.code] = item.label || item.code;
    }
  }
  return labels;
}

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ALLOWED_ORIGINS = new Set([
  "https://rafter.deepgreensea.au",
  "https://rafter.will-8e8.workers.dev",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://rafter.deepgreensea.au";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "vary": "Origin",
  };
}

function withCors(request, response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    let response;
    if (request.method === "GET" && url.pathname === "/health") {
      response = json({ ok: true });
    } else if (request.method === "POST" && url.pathname === "/generate") {
      response = await handleGenerate(request, env, url);
    } else {
      response = new Response("Not found", { status: 404 });
    }

    return withCors(request, response);
  },
};

const MAKE_WEBHOOK_PREFIX = "https://hook.eu1.make.com/";

async function hmacSha256(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function handleGenerate(request, env, url) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const mode = url.searchParams.get("mode") || payload.mode || "preview";
  if (mode !== "preview" && mode !== "submit") {
    return json({ error: "invalid_mode", got: mode }, 400);
  }

  const { client_uuid } = payload;
  if (!client_uuid) return json({ error: "missing_client_uuid" }, 400);

  // submit requires a short-lived HMAC token issued by materials-sync /get-form-token
  if (mode === "submit") {
    const authHeader = request.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token || !await verifyFormToken(token, client_uuid, env)) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  const client = await loadClient(env, client_uuid);

  if (mode === "submit" && !client.webhook_url) {
    return json({ error: "webhook_url_not_configured", client_uuid }, 400);
  }

  // Guard against SSRF via a compromised or misconfigured KV record
  if (mode === "submit" && !client.webhook_url.startsWith(MAKE_WEBHOOK_PREFIX)) {
    return json({ error: "invalid_webhook_url" }, 500);
  }

  const [logoDataUrl, photoMap] = await Promise.all([
    fetchLogo(env, client_uuid),
    fetchPhotos(env, collectPhotoKeys(payload)),
  ]);

  const html = buildHtml({ payload, client, logoDataUrl, photoMap });
  const pdf = await renderPdf(env, html);

  const filename = buildPdfFilename(payload, client);

  if (mode === "preview") {
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Submit: POST PDF + payload to Make Rafter Form webhook
  const form = new FormData();
  form.append("pdf", new Blob([pdf], { type: "application/pdf" }), filename);
  form.append("payload", JSON.stringify(payload));
  // Individual fields so Make can map without JSON parsing
  form.append("client_name",      payload.client_name      || "");
  // Only send client_sm8_uuid when set — empty string would defeat Make's
  // `notexist` branch routing in M21 (existing-vs-new client check).
  if (payload.client_sm8_uuid) form.append("client_sm8_uuid", payload.client_sm8_uuid);
  form.append("quote_ref",        payload.quote_ref        || "");
  form.append("site_address",     payload.site_address     || "");
  form.append("proposal_type",    payload.proposal_type    || "");
  form.append("proposal_date",    payload.proposal_date    || "");
  form.append("total",            String(payload.total     ?? ""));
  form.append("notes",            payload.notes            || "");
  form.append("job_description",  buildJobDescription(payload, buildProposalTypeLabels(client.proposal_types)));
  form.append("lineItems",        JSON.stringify(payload.lineItems || []));
  form.append("customer_email",   payload.customer_email   || "");
  form.append("send_email",       String(payload.send_email === true));

  const makeRes = await fetch(client.webhook_url, { method: "POST", body: form });
  if (!makeRes.ok) {
    const detail = await makeRes.text().catch(() => "");
    return json({ error: "make_webhook_failed", status: makeRes.status, detail: detail.slice(0, 500) }, 502);
  }

  return json({ ok: true, quote_ref: payload.quote_ref || null });
}

async function loadClient(env, uuid) {
  const raw = await env.RAFTER_CLIENTS.get(`client:${uuid}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function fetchLogo(env, uuid) {
  for (const key of [`clients/${uuid}/logo.png`, `clients/${uuid}/logo.jpg`, `clients/${uuid}/logo.jpeg`]) {
    try {
      const obj = await env.RAFTER_ASSETS.get(key);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      const mime = obj.httpMetadata?.contentType || mimeFromPath(key);
      return `data:${mime};base64,${arrayBufferToBase64(buf)}`;
    } catch {}
  }
  return null;
}

function collectPhotoKeys(payload) {
  const keys = new Set();
  for (const fs of (payload.form_sections || [])) {
    for (const k of (fs?.photos || [])) {
      if (typeof k === "string" && k) keys.add(k);
    }
  }
  return [...keys];
}

async function fetchPhotos(env, keys) {
  if (!keys.length) return new Map();
  const entries = await Promise.all(keys.map(async (k) => {
    try {
      const obj = await env.RAFTER_ASSETS.get(k);
      if (!obj) return [k, null];
      const buf = await obj.arrayBuffer();
      const mime = obj.httpMetadata?.contentType || mimeFromPath(k);
      return [k, `data:${mime};base64,${arrayBufferToBase64(buf)}`];
    } catch {
      return [k, null];
    }
  }));
  return new Map(entries);
}

function mimeFromPath(p) {
  const ext = p.toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" }[ext]) || "application/octet-stream";
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function renderPdf(env, html) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1240, height: 1754 });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

    // Compress section photos to 600px wide JPEG inside the browser context,
    // where Canvas API is available. Runs before PDF generation so the PDF
    // embeds the downscaled versions rather than the originals.
    await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll(".sect-photo img")];
      await Promise.all(imgs.map((img) => new Promise((resolve) => {
        if (!img.src.startsWith("data:")) { resolve(); return; }
        const tmp = new Image();
        tmp.onload = () => {
          try {
            const maxW = 400;
            const scale = Math.min(1, maxW / (tmp.naturalWidth || 1));
            const w = Math.max(1, Math.round(tmp.naturalWidth * scale));
            const h = Math.max(1, Math.round(tmp.naturalHeight * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            canvas.getContext("2d").drawImage(tmp, 0, 0, w, h);
            img.src = canvas.toDataURL("image/jpeg", 0.78);
          } catch (_) { /* leave original on any error */ }
          resolve();
        };
        tmp.onerror = resolve;
        tmp.src = img.src;
      })));
    });

    const footerTemplate = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; font-size: 9px; width: 100%; padding: 0 15mm; color: ${COLORS.muted}; text-align: right; box-sizing: border-box;">
        <span class="pageNumber"></span>
      </div>`;

    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", right: "0mm", bottom: "14mm", left: "0mm" },
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate,
      preferCSSPageSize: false,
    });
  } finally {
    await browser.close();
  }
}

function buildHtml({ payload, client, logoDataUrl, photoMap }) {
  const businessName = client.company_name || "";
  const businessAddress = client.business_address || "";
  const businessEmail = client.business_email || "";
  const businessAbn = client.abn || "";
  const phone = client.phone || "";
  const credentials = Array.isArray(client.credentials) ? client.credentials : [];
  const terms = Array.isArray(client.terms_and_conditions)
    ? client.terms_and_conditions
    : (client.terms_and_conditions ? [client.terms_and_conditions] : []);

  const proposalDate = payload.proposal_date || "";
  const quoteRef = payload.quote_ref || "";
  const clientName = payload.client_name || "";
  const siteAddress = formatSiteAddress(payload.site_address);
  const palette = resolveBranding(client.branding);
  const proposalLabels = buildProposalTypeLabels(client.proposal_types);
  const jobTitle = buildJobTitle(payload, proposalLabels);

  // RFT-32: prominent version marker on PDF face for v>1. Approval-risk
  // mitigation — if a customer signs the PDF, the document itself must state
  // which version they signed against. NOT a footer; sits between cover-rule
  // and job-title so it lands inside the cover's eye-line.
  const version = Number.isInteger(payload.version) && payload.version >= 1 ? payload.version : 1;
  const supersedesDate = payload.supersedes_date || "";

  const heroLogo = logoDataUrl
    ? `<img class="logo" src="${logoDataUrl}" alt="${escapeHtml(businessName)}">`
    : `<div class="logo-placeholder">${escapeHtml(businessName)}</div>`;

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<title>${escapeHtml(quoteRef || "Quote")}</title>
<style>
  @font-face {
    font-family: 'Mulish';
    font-style: normal;
    font-weight: 400;
    font-display: block;
    src: url(data:font/ttf;base64,${MULISH_400_TTF_B64}) format('truetype');
  }
  @font-face {
    font-family: 'Mulish';
    font-style: normal;
    font-weight: 700;
    font-display: block;
    src: url(data:font/ttf;base64,${MULISH_700_TTF_B64}) format('truetype');
  }
  @font-face {
    font-family: 'Playfair Display';
    font-style: normal;
    font-weight: 600;
    font-display: block;
    src: url(data:font/woff2;base64,${PLAYFAIR_600_LATIN_B64}) format('woff2');
  }
  :root {
    --lime: ${palette.accent};
    --dark: ${palette.primary};
    --ink: ${COLORS.ink};
    --scope: ${COLORS.scope};
    --asterisk: ${COLORS.asterisk};
    --body555: ${COLORS.body555};
    --muted: ${COLORS.muted};
    --soft: ${palette.background};
    --rule: ${COLORS.rule};
  }
  @page { size: A4; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10.5pt;
    line-height: 1.55;
    color: var(--ink);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .page { padding: 0 15mm; }

  /* ---------- Cover page ---------- */
  .cover-top { padding-top: 10mm; display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; }
  .cover-top .left { flex: 0 0 auto; }
  .cover-top .right { text-align: right; font-family: 'Mulish', sans-serif; font-weight: 400; font-size: 9.5pt; line-height: 1.55; color: var(--muted); }
  .cover-top .right .line { display: block; }
  .logo { max-width: 60mm; max-height: 28mm; object-fit: contain; display: block; }
  .logo-placeholder {
    background: var(--soft);
    padding: 6mm 8mm;
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 16pt;
    color: var(--dark);
    border-radius: 1mm;
  }

  .cover-mid { margin-top: 14mm; display: flex; justify-content: space-between; align-items: flex-end; gap: 12mm; }
  .prepared { flex: 1; }
  .prepared .label {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--lime);
    font-size: 9pt;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .prepared .name {
    margin-top: 3mm;
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    font-size: 22pt;
    line-height: 1.1;
    color: var(--ink);
  }
  .prepared .addr {
    margin-top: 2.5mm;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--muted);
    font-size: 10.5pt;
  }
  .meta {
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 6mm;
    row-gap: 1.5mm;
    align-items: baseline;
  }
  .meta-lbl {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--lime);
    font-size: 10.5pt;
    text-align: right;
  }
  .meta-val {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--ink);
    font-size: 10.5pt;
    text-align: right;
  }

  .cover-rule { margin-top: 10mm; border-top: 1px solid var(--rule); }

  /* RFT-32 version banner — only rendered for v>1 amendments */
  .version-banner {
    margin-top: 7mm;
    padding: 4mm 6mm;
    background: var(--dark);
    color: #fff;
    border-radius: 1mm;
    display: flex;
    flex-direction: column;
    gap: 1mm;
  }
  .version-banner .version-tag {
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    font-size: 12pt;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .version-banner .version-detail {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10pt;
    opacity: 0.92;
  }

  .job-title {
    margin-top: 7mm;
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 18pt;
    line-height: 1.2;
    color: var(--lime);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---------- Work sections ---------- */
  .work { margin-top: 8mm; }
  .section { margin-top: 8mm; }
  .section-h {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6mm;
    padding: 2.5mm 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .section-h-title {
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 14pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dark);
  }
  .section-h-price {
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    font-size: 11pt;
    color: var(--ink);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .item { margin-top: 4mm; }
  .item-scope {
    margin-top: 2.5mm;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10.5pt;
    line-height: 1.55;
    color: var(--scope);
  }
  .item-scope p { margin: 0 0 2mm 0; }
  .item-scope p:last-child { margin-bottom: 0; }
  .asterisk-notes {
    margin-top: 2mm;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 8.5pt;
    line-height: 1.55;
    color: var(--asterisk);
  }
  .asterisk-notes p { margin: 0 0 1mm 0; }

  /* ---------- Section photos (rendered under each section's scope) ---------- */
  .sect-photos {
    margin-top: 4mm;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3mm;
    page-break-inside: avoid;
  }
  .sect-photo {
    aspect-ratio: 4 / 3;
    overflow: hidden;
    border-radius: 1mm;
    background: #f0f0f0;
  }
  .sect-photo img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* ---------- Totals block (after work sections, before credentials) ---------- */
  .totals {
    margin-top: 8mm;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .totals-row {
    display: grid;
    grid-template-columns: auto auto;
    column-gap: 10mm;
    align-items: baseline;
    padding: 1mm 0;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10.5pt;
  }
  .totals-row .lbl {
    color: var(--muted);
    text-align: right;
    min-width: 25mm;
  }
  .totals-row .val {
    color: var(--ink);
    text-align: right;
    min-width: 35mm;
  }
  .totals-row.grand {
    margin-top: 2mm;
    padding-top: 3mm;
    border-top: 1px solid var(--rule);
    font-size: 13pt;
  }
  .totals-row.grand .lbl,
  .totals-row.grand .val {
    color: var(--dark);
  }

  /* ---------- Block sections (credentials, payment, bank, terms) ---------- */
  .block { margin-top: 10mm; }
  .block-h {
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 16pt;
    color: var(--dark);
    margin-bottom: 4mm;
  }

  /* Credentials — compact, tight spacing */
  .creds { display: grid; gap: 1.5mm; }
  .cred { display: flex; gap: 3mm; align-items: flex-start; }
  .cred-dot {
    flex-shrink: 0;
    width: 4.5mm;
    height: 4.5mm;
    border-radius: 50%;
    background: var(--ink);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1mm;
  }
  .cred-dot svg { width: 2.8mm; height: 2.8mm; display: block; }
  .cred-text {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10pt;
    line-height: 1.4;
    color: var(--ink);
    flex: 1;
  }
  .cred-text .detail {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--muted);
    font-size: 9.5pt;
  }

  /* Payment schedule */
  .pay-row {
    display: flex;
    align-items: baseline;
    gap: 5mm;
    padding: 3mm 0;
    border-bottom: 0.5px solid var(--rule);
  }
  .pay-pct {
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    color: var(--dark);
    width: 16mm;
    flex-shrink: 0;
  }
  .pay-desc {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--body555);
    flex: 1;
  }
  .pay-amt {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--ink);
    text-align: right;
    white-space: nowrap;
    min-width: 32mm;
  }
  .pay-notes {
    margin-top: 4mm;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 8.5pt;
    line-height: 1.55;
    color: var(--body555);
  }
  .pay-notes p { margin: 0 0 1mm 0; }

  /* Bank details */
  .bank-row {
    display: flex;
    gap: 4mm;
    padding: 1.5mm 0;
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    color: var(--body555);
    font-size: 10.5pt;
  }
  .bank-row .lbl { width: 30mm; color: var(--muted); }
  .bank-row .val { color: var(--body555); }

  /* Terms */
  .terms {
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10pt;
    line-height: 1.6;
    color: var(--body555);
  }
  .terms p { margin: 0 0 3mm 0; }
  .terms p:last-child { margin-bottom: 0; }

  /* ---------- Section-to-financial divider (BUG-18) ---------- */
  .section-divider {
    margin-top: 10mm;
    border-top: 1.5px solid var(--rule);
  }

  /* ---------- Financial summary — costs / payment / bank (BUG-19) ---------- */
  .financial-summary {
    margin-top: 8mm;
    padding: 8mm 10mm;
    background: var(--soft);
    border-radius: 2mm;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .financial-summary .totals {
    margin-top: 0;
  }
  .financial-summary .block {
    margin-top: 8mm;
  }
  .financial-summary .block-h {
    font-size: 13pt;
    margin-bottom: 3mm;
  }

  /* ---------- Appendix page (credentials + T&Cs only) ---------- */
  .appendix {
    page-break-before: always;
    break-before: page;
  }
  .appendix .block { margin-top: 10mm; }
  .appendix .block:first-child { margin-top: 0; }
  .appendix .block-h { font-size: 14pt; margin-bottom: 5mm; }
  /* Credentials — two columns */
  .appendix .creds {
    grid-template-columns: 1fr 1fr;
    column-gap: 6mm;
    row-gap: 2.5mm;
  }
  .appendix .cred { gap: 3mm; }
  .appendix .cred-dot { width: 4.5mm; height: 4.5mm; margin-top: 1mm; }
  .appendix .cred-dot svg { width: 2.8mm; height: 2.8mm; }
  .appendix .cred-text { font-size: 10pt; line-height: 1.4; }
  .appendix .cred-text .detail { font-size: 9.5pt; }
  /* Terms */
  .appendix .terms { font-size: 9pt; line-height: 1.6; }
  .appendix .terms p { margin: 0 0 3mm 0; }
</style>
</head>
<body>

<div class="page">

  <!-- Cover header -->
  <div class="cover-top">
    <div class="left">${heroLogo}</div>
    <div class="right">
      ${businessAddress ? `<span class="line">${escapeHtml(businessAddress).replace(/\n/g, "<br>")}</span>` : ""}
      ${businessEmail ? `<span class="line">${escapeHtml(businessEmail)}</span>` : ""}
      ${phone ? `<span class="line">${escapeHtml(phone)}</span>` : ""}
      ${businessAbn ? `<span class="line">ABN ${escapeHtml(businessAbn)}</span>` : ""}
    </div>
  </div>

  <!-- Prepared for + meta -->
  <div class="cover-mid">
    <div class="prepared">
      <div class="label">Prepared for</div>
      ${clientName ? `<div class="name">${escapeHtml(clientName)}</div>` : ""}
      ${siteAddress ? `<div class="addr">${escapeHtml(siteAddress)}</div>` : ""}
    </div>
    <div class="meta">
      ${proposalDate ? metaPair("Date", proposalDate) : ""}
    </div>
  </div>

  <div class="cover-rule"></div>

  ${version > 1 ? `
  <div class="version-banner">
    <span class="version-tag">Version ${version}</span>
    <span class="version-detail">Supersedes the version dated ${escapeHtml(supersedesDate || "(date unknown)")}</span>
  </div>
  ` : ""}

  <h1 class="job-title">${escapeHtml(jobTitle)}</h1>

  <div class="work">
    ${renderSections(payload.sections || [], payload.form_sections || [], photoMap)}
  </div>

  <div class="section-divider"></div>

  <div class="financial-summary">
    ${renderTotals(payload)}
    ${renderPaymentSchedule(payload.payment_schedule || [], payload.payment_notes || [])}
    ${renderBank(client.bank_details || payload.bank_details || {})}
  </div>

  <div class="appendix">
    ${renderCredentials(credentials, businessName)}
    ${renderTerms(terms)}
  </div>

</div>

</body>
</html>`;
}

function metaPair(label, value) {
  return `<span class="meta-lbl">${escapeHtml(label)}</span><span class="meta-val">${escapeHtml(value)}</span>`;
}

function formatSiteAddress(addr) {
  if (!addr) return "";
  return String(addr).replace(/,\s*Australia\s*$/i, "").trim();
}

function buildJobTitle(payload, labels) {
  if (payload.job_title) return payload.job_title;
  const typeLabel = (labels && labels[payload.proposal_type]) || "Proposal";
  const street = payload.street_address || parseStreet(payload.site_address);
  const suburb = payload.suburb || parseSuburb(payload.site_address);
  const location = [street, suburb].filter(Boolean).join(", ");
  return location ? `${typeLabel} — ${location}` : typeLabel;
}

function parseStreet(addr) {
  if (!addr) return "";
  return addr.split(",")[0].trim();
}

function parseSuburb(addr) {
  if (!addr) return "";
  const parts = addr.split(",");
  if (parts.length < 2) return "";
  let s = parts[1].trim();
  s = s.replace(/\s+(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b.*$/i, "").trim();
  s = s.replace(/\s+Australia$/i, "").trim();
  return s;
}

function renderSections(sections, formSections, photoMap) {
  if (!sections.length) return "";
  return sections.map((s, i) => renderSection(s, formSections?.[i]?.photos || [], photoMap)).join("");
}

function renderSection(section, photoKeys, photoMap) {
  const items = (section.items || []).map(renderItem).join("");
  const photos = renderSectionPhotos(photoKeys, photoMap);
  const price = section.items?.[0]?.price != null ? AUD.format(section.items[0].price) : "";
  return `<div class="section">
    <div class="section-h">
      <span class="section-h-title">${escapeHtml(section.heading || "")}</span>
      ${price ? `<span class="section-h-price">${escapeHtml(price)}</span>` : ""}
    </div>
    ${items}
    ${photos}
  </div>`;
}

function renderSectionPhotos(keys, photoMap) {
  if (!keys?.length || !photoMap) return "";
  const tiles = keys
    .map((k) => photoMap.get(k))
    .filter(Boolean)
    .map((url) => `<div class="sect-photo"><img src="${url}" alt=""></div>`)
    .join("");
  if (!tiles) return "";
  return `<div class="sect-photos">${tiles}</div>`;
}

function renderItem(item) {
  const scope = item.scope ? paragraphs(item.scope, "item-scope") : "";
  const notes = Array.isArray(item.asterisk_notes) && item.asterisk_notes.length
    ? `<div class="asterisk-notes">${item.asterisk_notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`
    : "";
  return `<div class="item">${scope}${notes}</div>`;
}

function paragraphs(text, className) {
  const paras = String(text)
    .split(/\n\n+/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div class="${className}">${paras}</div>`;
}

function renderTotals(payload) {
  if (payload.subtotal == null && payload.gst == null && payload.total == null) return "";
  return `<section class="totals">
    ${payload.subtotal != null ? `<div class="totals-row"><span class="lbl">Subtotal</span><span class="val">${AUD.format(payload.subtotal)}</span></div>` : ""}
    ${payload.gst != null ? `<div class="totals-row"><span class="lbl">GST</span><span class="val">${AUD.format(payload.gst)}</span></div>` : ""}
    ${payload.total != null ? `<div class="totals-row grand"><span class="lbl">Total</span><span class="val">${AUD.format(payload.total)}</span></div>` : ""}
  </section>`;
}

function renderCredentials(credentials, businessName) {
  if (!credentials.length) return "";
  const check = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12 10 17 19 8"/></svg>`;
  const rows = credentials
    .map((c) => {
      const name = typeof c === "string" ? c : (c.name || "");
      const detail = typeof c === "string" ? "" : (c.detail || "");
      return `<div class="cred">
        <div class="cred-dot">${check}</div>
        <div class="cred-text">
          <div>${escapeHtml(name)}</div>
          ${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ""}
        </div>
      </div>`;
    })
    .join("");
  return `<section class="block">
    <h2 class="block-h">You can rely on ${escapeHtml(businessName)}</h2>
    <div class="creds">${rows}</div>
  </section>`;
}

function renderPaymentSchedule(schedule, notes) {
  if (!schedule.length) return "";
  const rows = schedule
    .map((p) => `<div class="pay-row">
      <div class="pay-pct">${p.percentage != null ? `${p.percentage}%` : ""}</div>
      <div class="pay-desc">${escapeHtml(p.description || "")}</div>
      <div class="pay-amt">${p.amount != null ? AUD.format(p.amount) : ""}</div>
    </div>`)
    .join("");
  const notesHtml = Array.isArray(notes) && notes.length
    ? `<div class="pay-notes">${notes.slice(0, 2).map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`
    : "";
  const paymentNote = `<div class="pay-notes" style="margin-top:3mm;">All completed variations are to be paid at completion of the next progress payment stage. All progress invoices are due within 1 day of completion.</div>`;
  return `<section class="block">
    <h2 class="block-h">Payment Schedule</h2>
    ${rows}
    ${notesHtml}
    ${paymentNote}
  </section>`;
}

function renderBank(bank) {
  if (!bank.name && !bank.bsb && !bank.account) return "";
  return `<section class="block">
    <h2 class="block-h">Bank Details</h2>
    ${bank.name ? `<div class="bank-row"><div class="lbl">Account Name</div><div class="val">${escapeHtml(bank.name)}</div></div>` : ""}
    ${bank.bsb ? `<div class="bank-row"><div class="lbl">BSB</div><div class="val">${escapeHtml(bank.bsb)}</div></div>` : ""}
    ${bank.account ? `<div class="bank-row"><div class="lbl">Account</div><div class="val">${escapeHtml(bank.account)}</div></div>` : ""}
  </section>`;
}

function renderTerms(terms) {
  if (!terms.length) return "";
  const paras = terms.map((t) => `<p>${escapeHtml(t).replace(/\n/g, "<br>")}</p>`).join("");
  return `<section class="block">
    <h2 class="block-h">Terms and Conditions</h2>
    <div class="terms">${paras}</div>
  </section>`;
}

// PDF-as-object naming (RFT-32, 2026-06-06): customer name leads, version
// token tail, ISO date for sortability. Drops the HHMM-bearing quote_ref
// from the customer-facing filename — the internal quote_ref still lives
// in payload.quote_ref, the PDF body, the rafter-quotes row, and the SM8
// job_description block. The PDF as an object the customer holds shouldn't
// be tagged with a machine timestamp.
function buildPdfFilename(payload, client) {
  const customer = slugForFilename(payload.client_name || "Customer");
  const dateStr = formatPdfFilenameDate(payload.proposal_date);
  const labels = buildProposalTypeLabels(client && client.proposal_types);
  const ptypeRaw = (labels && labels[payload.proposal_type]) || payload.proposal_type || "Quote";
  const ptype = slugForFilename(ptypeRaw);
  const v = Number.isInteger(payload.version) && payload.version >= 1 ? payload.version : 1;
  const parts = [customer, dateStr, ptype, `v${v}`].filter(Boolean);
  return `${parts.join("-") || "quote"}.pdf`;
}

function slugForFilename(s) {
  return String(s || "")
    .replace(/[\\\/:*?"<>|\x00-\x1f]/g, "")  // filesystem-unsafe
    .replace(/[^\w\s\-]/g, "")                // strip other punctuation
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

function formatPdfFilenameDate(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function buildJobDescription(payload, labels) {
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
    const price = s.items?.[0]?.price != null ? AUD.format(s.items[0].price) : "";
    lines.push(`${heading}${price ? " — " + price : ""}`);
    const scope = s.items?.[0]?.scope || "";
    if (scope) lines.push(scope);
    lines.push("");
  }

  if (payload.total != null) lines.push(`Total (inc. GST): ${AUD.format(payload.total)}`);
  if (payload.notes) { lines.push(""); lines.push(`Notes: ${payload.notes}`); }

  lines.push(`--- RAFTER:${ref}:END ---`);
  return lines.join("\n");
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
