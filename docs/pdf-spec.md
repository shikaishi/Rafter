# PDF spec

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Inject

Fonts must be base64-inlined via `workers/pdf/fonts.js` (`MULISH_400_TTF_B64`,
`MULISH_700_TTF_B64`, `PLAYFAIR_600_LATIN_B64`). Google Fonts CDN
(`fonts.googleapis.com`, `fonts.gstatic.com`) does NOT load in headless Chromium —
the request times out silently and the PDF renders in a fallback face that breaks layout.
Browser pages under `workers/rafter/*.html` legitimately use Google Fonts; this rule
applies to `workers/pdf/index.js` only.

Photo compression runs inside `page.evaluate()` (Puppeteer browser context), not in the
Worker. `OffscreenCanvas` does not exist in the Workers runtime — moving compression up
breaks the deploy. Target = 400px wide, JPEG quality 0.78 (lines 264 and 271). The same
target is applied at ingest in `onboarding.html:resizePhoto` so R2 is already correct.

`compatibility_flags = ["nodejs_compat"]` + `compatibility_date = "2024-09-23"` are
required in `workers/pdf/wrangler.toml` for puppeteer. Removing either breaks the deploy.

Branding presets are single-source in `workers/pdf/index.js` lines 13-35 (`PRESETS`,
`PLATFORM_DEFAULTS`, `resolveBranding`). `rafter-pdf` exposes them via `GET /presets`;
admin-api proxies via the `PDF_WORKER` service binding and settings.html lazy-fetches.
Never inline-mirror the palette list anywhere — swatch-vs-rendered-PDF drift is the
worst branding failure mode (RFT-105 explicit warning). `resolveBranding` falls through
to `PLATFORM_DEFAULTS` on unknown keys, so removing a preset never crashes — orphan
tenants render in the platform palette.

The PDF preview's `window.open()` MUST stay synchronous inside the click handler in
`workers/rafter/index.html`. Moving it after an `await` lets the browser pop-up
blocker kill it. The interstitial is `win.document.write()`-d before the fetch starts.

Quote title is hardcoded in `pdf/index.js:24-27` (`PROPOSAL_TYPE_LABEL`). The
`client.proposal_types` KV field is dead — no reader. Don't wire it back without
Will's design decision (open issue).

Footer has page number only. No URL, no timestamp. Cover page has no proposal number.
Numerals are Mulish — Playfair is reserved for ALL CAPS headings + job title.

## Reference

**Font loading:** Google Fonts does NOT load in headless Chromium. All fonts (Mulish 400/700,
Playfair Display 600) must be inlined as base64 data URIs. Do not reference Google Fonts CDN.

**Photo compression:** Section photos are compressed inside the Puppeteer browser context (via Canvas API) before PDF generation — resized to 400px wide at JPEG quality 0.78 (`pdf/index.js:264,271`). `OffscreenCanvas` is not available in the Cloudflare Workers runtime so compression cannot happen in the Worker itself; it must run inside `page.evaluate()` where the full browser Canvas API is available. A 20-photo quote produces ~2MB. Do not move compression back to the Worker layer. **The same 400px/q0.78 target is used at ingest time (onboarding Step 4, `onboarding.html:resizePhoto`)** so photos stored in R2 are already correctly-sized — consistent with Make's 5MB payload limit.

**PDF preview loading screen:** `index.html` writes a branded interstitial to the new tab synchronously (before the fetch) using `win.document.write()`. It shows `client.logo_url` pulsing over the `#ECF1E8` background with animated lime dots. Falls back to `client.company_name` as text if no logo. The window then navigates to the PDF blob URL when rendering completes. The `window.open()` call must remain synchronous inside the click handler — moving it after an `await` causes browsers to block it as a popup.

## PDF design spec (locked — T1-D1 complete)

**Cover page (Page 1 only):**
1. Header: phone left (lime `#84B741`) · total right (lime) · thin rule
2. Logo from R2 left · business address/ABN right
3. "PREPARED FOR" lime uppercase · client name large bold · full address
4. Meta block right-aligned: Date / Reference / Total — lime label + Mulish 400 value. **No proposal number.**
5. Horizontal rule
6. Job title Playfair lime: `{type} — {street}, {suburb}` — no state, no country, one line

**Sections:** Playfair 600 ALL CAPS dark green heading · item name Mulish 700 + price right-aligned · rule · scope Mulish 400 · asterisk notes `#999`

**Footer:** page number right only, every page. No URL, no timestamp.

**Typography rules:**
- Playfair Display 600: section headings (ALL CAPS), block headings, job title
- Mulish 700: item names and prices
- Mulish 400: everything else
- All numbers in Mulish — no Playfair numerals
