#!/usr/bin/env node
// PreToolUse hook — Rafter convention enforcement
//
// Reads the Edit/Write tool invocation from stdin and writes a hookSpecificOutput
// JSON to stdout. Two middlewares run in order: structureCheck (blocks bad new
// file placement) and codeContext (injects relevant docs/*.md ## Inject sections).
//
// All-matches routing: every route that matches the edited path contributes a doc.
// Injection order = general → specific so the most-specific guidance sits closest
// to the agent's edit point (recency privilege).
//
// Pattern source: https://andrewpatterson.dev/posts/agent-convention-enforcement-system/

import fs from 'node:fs';
import path from 'node:path';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function stripProjectRoot(rawPath) {
  if (!rawPath) return '';
  // Normalise both sides to absolute Windows-style with forward slashes so
  // Git Bash's Unix-style stdin payloads (/c/Users/...) match against
  // Cygwin-translated env vars (C:/Users/...). path.resolve handles drive
  // prefix coercion on Windows and is a no-op on POSIX.
  let abs;
  try { abs = path.resolve(rawPath); }
  catch { abs = rawPath; }
  const normAbs = abs.replace(/\\/g, '/');
  const normRoot = path.resolve(PROJECT_ROOT).replace(/\\/g, '/');
  if (normAbs.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
    return normAbs.slice(normRoot.length + 1);
  }
  if (normAbs.toLowerCase() === normRoot.toLowerCase()) return '';
  // Fallback: try Git Bash's /c/-style → C:/-style coercion explicitly.
  const gitBashMatch = rawPath.match(/^\/([a-zA-Z])\/(.*)/);
  if (gitBashMatch) {
    const winForm = `${gitBashMatch[1].toUpperCase()}:/${gitBashMatch[2]}`;
    if (winForm.toLowerCase().startsWith(normRoot.toLowerCase() + '/')) {
      return winForm.slice(normRoot.length + 1);
    }
  }
  return normAbs;
}

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); }
  catch { return ''; }
}

function emit({ additionalContext = '', blockReason = '' }) {
  if (blockReason) {
    process.stderr.write(blockReason + '\n');
    process.exit(2);
  }
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext,
      },
    }));
  }
  process.exit(0);
}

function readDocInject(relPath) {
  const abs = path.join(PROJECT_ROOT, relPath);
  let content;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch { return null; }
  const injectStart = content.indexOf('\n## Inject\n');
  if (injectStart < 0) return content;
  const sliceStart = injectStart + '\n## Inject\n'.length;
  // End at the next ## heading (any level >= 2).
  const rest = content.slice(sliceStart);
  const nextHeading = rest.search(/\n## /);
  const body = nextHeading < 0 ? rest : rest.slice(0, nextHeading);
  return body.trim();
}

// ── Middleware 1: structureCheck ─────────────────────────────────────────────
//
// Block creation of files that don't belong. The Rafter repo layout is fixed:
// every worker lives under workers/<name>/, no other directory holds worker
// code, and there are no nested service / route / model dirs inside a worker.
// Each worker is a flat dir with index.js + wrangler.toml (or *.html for the
// asset-only workers).

const KNOWN_WORKERS = new Set(['admin-api', 'materials-sync', 'pdf', 'rafter', 'ops-console']);

function structureCheck(ctx) {
  // Only fire on Write operations (Edit operates on an existing file).
  if (ctx.toolName !== 'Write') return null;
  const rel = ctx.filePath;
  if (!rel) return null;

  // Reject worker code at repo root. If a top-level *.js file looks like a worker
  // (imports from @clerk/backend, declares fetch handler, etc), it should be
  // under workers/<name>/. Conservative match: any top-level *.js that isn't a
  // build/config file.
  const topLevelJsBlocklist = /^[^/]+\.(js|mjs|ts)$/;
  if (topLevelJsBlocklist.test(rel) && !/^(scripts\/|workers\/)/.test(rel)) {
    // Allow build/config — package.json, wrangler.toml are TOML/JSON, not js.
    return {
      blockReason: [
        `Refusing to create top-level file ${rel}.`,
        'Worker code belongs under workers/<name>/. Scripts belong under scripts/.',
        'If this is genuinely a repo-root utility, override by writing to the proper location first.',
      ].join('\n'),
    };
  }

  // Reject new workers/<unknown>/ directory.
  const newWorkerMatch = rel.match(/^workers\/([^/]+)\//);
  if (newWorkerMatch) {
    const workerName = newWorkerMatch[1];
    if (!KNOWN_WORKERS.has(workerName)) {
      // Only block if the worker dir doesn't exist yet (i.e. this is the file
      // that would create it). Edit-to-existing-file should never reach here
      // because Edit isn't a Write.
      const workerDir = path.join(PROJECT_ROOT, 'workers', workerName);
      if (!fs.existsSync(workerDir)) {
        return {
          blockReason: [
            `Refusing to create new worker dir workers/${workerName}/.`,
            `Known workers: ${[...KNOWN_WORKERS].sort().join(', ')}.`,
            'A new worker needs CLAUDE.md repo-structure table updated AND a service-binding plan. Stop and confirm with Will.',
          ].join('\n'),
        };
      }
    }
  }

  // Reject nested subdirs inside an existing worker (services/, routes/, etc).
  // Workers are intentionally flat — workers/<name>/index.js is the only entry point.
  const insideWorkerMatch = rel.match(/^workers\/([^/]+)\/([^/]+)\/(.+)/);
  if (insideWorkerMatch) {
    const [, workerName, subdir] = insideWorkerMatch;
    // Allow node_modules (npm install creates it) and any pre-existing subdir.
    const subdirAbs = path.join(PROJECT_ROOT, 'workers', workerName, subdir);
    const allowedSubdirs = new Set(['node_modules']);
    if (!allowedSubdirs.has(subdir) && !fs.existsSync(subdirAbs)) {
      return {
        blockReason: [
          `Refusing to create workers/${workerName}/${subdir}/.`,
          'Rafter workers are intentionally flat: index.js + wrangler.toml (+ fonts.js for pdf).',
          'New subdirs introduce a layer the convention does not have. Stop and confirm with Will.',
        ].join('\n'),
      };
    }
  }

  return null;
}

// ── Middleware 2: codeContext ────────────────────────────────────────────────
//
// All-matches routing. Each route is { match: RegExp, docs: [relPaths] }. Every
// route that matches the edited path contributes its docs. Final order =
// general → specific, deduped by doc path (first occurrence wins on position).
//
// Routes are derived from the actual repo layout — not invented. Edit only if
// the layout changes.

const ROUTES = [
  // wrangler.toml in any worker → workers-reference.md
  { match: /^workers\/[^/]+\/wrangler\.toml$/, docs: ['docs/workers-reference.md', 'docs/safety-rules.md'] },

  // admin-api — Clerk JWT surface + safety
  { match: /^workers\/admin-api\//, docs: ['docs/safety-rules.md', 'docs/workers-reference.md', 'docs/clerk-reference.md'] },
  // admin-api onboarding routes need the onboarding doc
  // (PreToolUse can't peek inside a multi-line Edit body, so we use the path heuristic:
  //  admin-api/index.js touches the dispatcher anyway, so always include onboarding for
  //  admin-api edits — it's the worker that owns the surface)
  { match: /^workers\/admin-api\/index\.js$/, docs: ['docs/onboarding-reference.md', 'docs/sm8-api.md', 'docs/d1-schema.md'] },

  // materials-sync — KV writes + SM8 calls
  { match: /^workers\/materials-sync\//, docs: ['docs/workers-reference.md', 'docs/sm8-api.md', 'docs/safety-rules.md'] },
  { match: /^workers\/materials-sync\/index\.js$/, docs: ['docs/d1-schema.md'] },

  // pdf
  { match: /^workers\/pdf\//, docs: ['docs/workers-reference.md', 'docs/pdf-spec.md'] },

  // rafter operator form HTML — Clerk browser usage
  { match: /^workers\/rafter\/.*\.html$/, docs: ['docs/clerk-reference.md'] },
  { match: /^workers\/rafter\/index\.html$/, docs: ['docs/form-design.md', 'docs/pdf-spec.md'] },
  { match: /^workers\/rafter\/onboarding\.html$/, docs: ['docs/onboarding-reference.md'] },
  { match: /^workers\/rafter\/settings\.html$/, docs: ['docs/onboarding-reference.md'] },
  { match: /^workers\/rafter\/setup\.html$/, docs: ['docs/sm8-api.md'] },
  { match: /^workers\/rafter\/callback\.html$/, docs: ['docs/sm8-api.md'] },

  // ops-console
  { match: /^workers\/ops-console\//, docs: ['docs/workers-reference.md', 'docs/clerk-reference.md'] },

  // Make blueprints (if Will adds them)
  { match: /^make-blueprints\//, docs: ['docs/make-reference.md'] },
];

function codeContext(ctx) {
  const rel = ctx.filePath;
  if (!rel) return null;

  // No-op: edits inside docs/ are the docs themselves — don't inject docs into docs.
  if (rel.startsWith('docs/') || rel === 'CLAUDE.md' || rel === 'TRADIE.md') return null;

  const matchedDocs = [];
  const seen = new Set();
  for (const route of ROUTES) {
    if (!route.match.test(rel)) continue;
    for (const doc of route.docs) {
      if (seen.has(doc)) continue;
      seen.add(doc);
      matchedDocs.push(doc);
    }
  }

  if (!matchedDocs.length) return null;

  const blocks = [];
  for (const doc of matchedDocs) {
    const body = readDocInject(doc);
    if (!body) continue;
    blocks.push(`### Context from ${doc}\n${body}`);
  }
  if (!blocks.length) return null;

  return {
    additionalContext: [
      `Convention context for ${rel} — injected by Rafter PreToolUse hook.`,
      '',
      ...blocks,
    ].join('\n\n'),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  let input;
  try { input = JSON.parse(readStdinSync()); }
  catch { emit({}); return; }

  const toolName = input?.tool_name;
  const toolInput = input?.tool_input || {};

  // Only fire on Edit / Write.
  if (toolName !== 'Edit' && toolName !== 'Write') { emit({}); return; }

  const rawPath = toolInput.file_path || '';
  const ctx = { toolName, filePath: stripProjectRoot(rawPath) };

  // Run middlewares in order.
  const structureResult = structureCheck(ctx);
  if (structureResult?.blockReason) {
    emit(structureResult);
    return;
  }

  const contextResult = codeContext(ctx);
  if (contextResult?.additionalContext) {
    emit(contextResult);
    return;
  }

  emit({});
}

main();
