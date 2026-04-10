#!/usr/bin/env node
/**
 * Ensures every `https://www.sofascore.com/api/v1/...` path found under
 * `Sofascore api documentation/` matches at least one template in
 * `sofa-documented-paths.catalog.ts`.
 *
 * Run: node scripts/verify-doc-path-catalog.mjs
 * Add to CI: npm run verify:doc-paths
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadTemplates() {
  const catalogPath = path.join(
    root,
    'src/modules/contract/sofa-documented-paths.catalog.ts',
  );
  const text = fs.readFileSync(catalogPath, 'utf8');
  const start = text.indexOf('SOFASCORE_DOCUMENTED_PATH_TEMPLATES');
  if (start < 0) throw new Error('Catalog array not found');
  const slice = text.slice(start);
  const open = slice.indexOf('[');
  const close = slice.indexOf('];');
  if (open < 0 || close < 0) throw new Error('Catalog brackets not found');
  const body = slice.slice(open + 1, close);
  const templates = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*'([^']+)'\s*,?\s*$/);
    if (m) templates.push(m[1]);
  }
  if (templates.length === 0) throw new Error('No templates parsed');
  return templates;
}

function templateToRegex(template) {
  const parts = String(template).split(/(\{[^}]+\})/);
  let pattern = '^';
  for (const part of parts) {
    if (part.startsWith('{') && part.endsWith('}')) {
      pattern += '[^/]+';
    } else {
      pattern += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

function collectDocPaths() {
  const docDir = path.join(root, 'Sofascore api documentation');
  const paths = new Set();
  if (!fs.existsSync(docDir)) {
    console.warn('No Sofascore api documentation/ folder — skipping doc scan.');
    return paths;
  }

  const walk = (dir) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.md')) {
        const content = fs.readFileSync(p, 'utf8');
        const re =
          /https:\/\/www\.sofascore\.com\/api\/v1\/([^?\s<>"']+)/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          let rel = m[1].replace(/\\/g, '').trim();
          if (rel.endsWith('>')) rel = rel.slice(0, -1);
          const q = rel.indexOf('?');
          if (q >= 0) rel = rel.slice(0, q);
          paths.add(rel);
        }
      }
    }
  };
  walk(docDir);
  return paths;
}

function matchesAnyTemplate(relPath, templates) {
  const regexes = templates.map(templateToRegex);
  return regexes.some((re) => re.test(relPath));
}

const templates = loadTemplates();
const docPaths = collectDocPaths();
const missing = [];

for (const p of docPaths) {
  if (!matchesAnyTemplate(p, templates)) {
    missing.push(p);
  }
}

if (missing.length > 0) {
  console.error(
    'Doc paths not covered by SOFASCORE_DOCUMENTED_PATH_TEMPLATES:\n',
    missing.sort().join('\n'),
  );
  process.exit(1);
}

console.log(
  `OK: ${docPaths.size} unique doc paths match the catalog (${templates.length} templates).`,
);
process.exit(0);
