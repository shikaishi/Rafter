import puppeteer from "@cloudflare/puppeteer";
import { MULISH_400_TTF_B64, MULISH_700_TTF_B64, PLAYFAIR_600_LATIN_B64 } from "./fonts.js";

const COLORS = {
  lime: "#84B741",
  darkGreen: "#0D2E1C",
  ink: "#1a1a1a",
  scope: "#444",
  asterisk: "#999",
  body555: "#555",
  muted: "#666",
  softBg: "#ECF1E8",
  rule: "#D0D0D0",
};

const AUD = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MAKE_RAFTER_FORM_WEBHOOK = "https://hook.eu1.make.com/oh8gh9i7cdadlmmcyh3ypeep1x1n9jd4";

const PROPOSAL_TYPE_LABEL = {
  LC: "Landscape Construction",
  GM: "Garden Maintenance",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/generate") {
      return handleGenerate(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

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

  const client = await loadClient(env, client_uuid);
  const logoDataUrl = await fetchLogo(env, client_uuid);

  const html = buildHtml({ payload, client, logoDataUrl });
  const pdf = await renderPdf(env, html);

  if (mode === "preview") {
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${payload.quote_ref || "quote"}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Submit: POST PDF + payload to Make Rafter Form webhook
  const form = new FormData();
  form.append("pdf", new Blob([pdf], { type: "application/pdf" }), `${payload.quote_ref || "quote"}.pdf`);
  form.append("payload", JSON.stringify(payload));
  // Individual fields so Make can map without JSON parsing
  form.append("client_name",      payload.client_name      || "");
  form.append("client_sm8_uuid",  payload.client_sm8_uuid  || "");
  form.append("quote_ref",        payload.quote_ref        || "");
  form.append("site_address",     payload.site_address     || "");
  form.append("proposal_type",    payload.proposal_type    || "");
  form.append("proposal_date",    payload.proposal_date    || "");
  form.append("total",            String(payload.total     ?? ""));
  form.append("notes",            payload.notes            || "");
  form.append("job_description",  buildJobDescription(payload));

  const makeRes = await fetch(MAKE_RAFTER_FORM_WEBHOOK, { method: "POST", body: form });
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
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);

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

function buildHtml({ payload, client, logoDataUrl }) {
  const businessName = client.business_name || "2 Men and a Shovel";
  const businessAddress = client.business_address || "";
  const businessEmail = client.business_email || "";
  const businessAbn = client.abn || "";
  const phone = client.phone || "";
  const credentials = Array.isArray(client.credentials) ? client.credentials : [];
  const terms = Array.isArray(client.terms_and_conditions)
    ? client.terms_and_conditions
    : (client.terms_and_conditions ? [client.terms_and_conditions] : []);

  const proposalNumber = payload.proposal_number || "";
  const proposalDate = payload.proposal_date || "";
  const quoteRef = payload.quote_ref || "";
  const clientName = payload.client_name || "";
  const siteAddress = formatSiteAddress(payload.site_address);
  const totalStr = payload.total != null ? AUD.format(payload.total) : "";

  const jobTitle = buildJobTitle(payload);

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
    --lime: ${COLORS.lime};
    --dark: ${COLORS.darkGreen};
    --ink: ${COLORS.ink};
    --scope: ${COLORS.scope};
    --asterisk: ${COLORS.asterisk};
    --body555: ${COLORS.body555};
    --muted: ${COLORS.muted};
    --soft: ${COLORS.softBg};
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

  /* ---------- Page 1 banner (phone + total) ---------- */
  .page1-banner {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-top: 2mm;
    padding-bottom: 3mm;
    border-bottom: 0.5px solid var(--rule);
    color: var(--lime);
    font-family: 'Mulish', sans-serif;
    font-weight: 400;
    font-size: 10pt;
  }

  /* ---------- Cover page ---------- */
  .cover-top { padding-top: 7mm; display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm; }
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
    font-family: 'Playfair Display', serif;
    font-weight: 600;
    font-size: 14pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dark);
    padding-bottom: 2.5mm;
    border-bottom: 1px solid var(--rule);
  }
  .item { margin-top: 4mm; }
  .item-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 6mm;
    padding-bottom: 2mm;
    border-bottom: 0.5px solid var(--rule);
  }
  .item-name {
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    font-size: 11pt;
    color: var(--ink);
  }
  .item-price {
    font-family: 'Mulish', sans-serif;
    font-weight: 700;
    font-size: 11pt;
    color: var(--ink);
    white-space: nowrap;
  }
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
    background: var(--lime);
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
</style>
</head>
<body>

<div class="page">

  <!-- Page 1 banner: phone + total (cover only — natural content flow keeps this off pages 2+) -->
  <div class="page1-banner">
    <span>${escapeHtml(phone)}</span>
    <span>${escapeHtml(totalStr)}</span>
  </div>

  <!-- Cover header -->
  <div class="cover-top">
    <div class="left">${heroLogo}</div>
    <div class="right">
      ${businessAddress ? `<span class="line">${escapeHtml(businessAddress).replace(/\n/g, "<br>")}</span>` : ""}
      ${businessEmail ? `<span class="line">${escapeHtml(businessEmail)}</span>` : ""}
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
      ${quoteRef ? metaPair("Reference", quoteRef) : ""}
      ${totalStr ? metaPair("Total", totalStr) : ""}
    </div>
  </div>

  <div class="cover-rule"></div>

  <h1 class="job-title">${escapeHtml(jobTitle)}</h1>

  <div class="work">
    ${renderSections(payload.sections || [])}
  </div>

  ${renderTotals(payload)}
  ${renderCredentials(credentials)}
  ${renderPaymentSchedule(payload.payment_schedule || [], payload.payment_notes || [])}
  ${renderBank(payload.bank_details || {})}
  ${renderTerms(terms)}

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

function buildJobTitle(payload) {
  if (payload.job_title) return payload.job_title;
  const typeLabel = PROPOSAL_TYPE_LABEL[payload.proposal_type] || "Proposal";
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

function renderSections(sections) {
  if (!sections.length) return "";
  return sections.map(renderSection).join("");
}

function renderSection(section) {
  const items = (section.items || []).map(renderItem).join("");
  return `<div class="section">
    <div class="section-h">${escapeHtml(section.heading || "")}</div>
    ${items}
  </div>`;
}

function renderItem(item) {
  const price = item.price != null ? AUD.format(item.price) : "";
  const scope = item.scope ? paragraphs(item.scope, "item-scope") : "";
  const notes = Array.isArray(item.asterisk_notes) && item.asterisk_notes.length
    ? `<div class="asterisk-notes">${item.asterisk_notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("")}</div>`
    : "";
  return `<div class="item">
    <div class="item-head">
      <div class="item-name">${escapeHtml(item.name || "")}</div>
      <div class="item-price">${escapeHtml(price)}</div>
    </div>
    ${scope}
    ${notes}
  </div>`;
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

function renderCredentials(credentials) {
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
    <h2 class="block-h">You can rely on 2 Men and a Shovel</h2>
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
  return `<section class="block">
    <h2 class="block-h">Payment Schedule</h2>
    ${rows}
    ${notesHtml}
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

function buildJobDescription(payload) {
  const ref = payload.quote_ref || "";
  const lines = [
    `--- RAFTER:${ref}:START ---`,
    `Ref:  ${ref}`,
    `Date: ${payload.proposal_date || ""}`,
    `Type: ${PROPOSAL_TYPE_LABEL[payload.proposal_type] || payload.proposal_type || ""}`,
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
