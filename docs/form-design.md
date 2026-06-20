# Form design (CSS variables)

Extracted verbatim from CLAUDE.md (pre-split). For canonical UUIDs and safety rules, see CLAUDE.md.

## Inject

Operator form palette is locked at the CSS-variable layer in `workers/rafter/index.html`.
Edits to the `:root` block change chrome for every tenant — these are platform variables,
not branding values.

`--rf-green: #0D2E1C` and `--rf-lime: #84B741` are Andy-specific brand values that leaked
into the platform palette. Per-tenant branding belongs in the `branding` pane of
`/settings` (RFT-105 single-source presets in `workers/pdf/index.js`), not in the form's
CSS variables. Don't add more tenant-specific colour names here.

Devices: 768px minimum, tablet landscape, touch-first (D10). Mobile out of scope.

## Operator form design (index.html) — CSS variables

```css
--rf-navy: #1B4F72;
--rf-ocean: #2E86AB;
--rf-teal-bg: #EAF4F8;
--rf-teal-border: #A8D5E2;
--rf-outer: #1B3A52;
--rf-card: #FFFFFF;
--rf-row-bg: #F7F9FC;
--rf-border: #D4D0C8;
--rf-divider: #E8E4DC;
--rf-text: #1C1C1C;
--rf-muted: #6B6860;
--rf-green: #0D2E1C;
--rf-lime: #84B741;
--rf-danger-bg: #FFCDD2;
--rf-danger: #E57373;
```
