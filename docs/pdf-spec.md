# PDF spec

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

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
