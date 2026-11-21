#!/usr/bin/env node
'use strict';
/* Keeps styles.css in step with the Figma design tokens (design/tokens.json).

   node tools/tokens.js          check: list every value that differs (exit 1 if any)
   node tools/tokens.js --write  apply: copy the Figma values into styles.css

   design/tokens.json is exported from the Figma file's variables
   (Light/Dark colour modes + spacing/radius). No dependencies. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSS = path.join(ROOT, 'styles.css');
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'tokens.json'), 'utf8'));
const write = process.argv.includes('--write');
let css = fs.readFileSync(CSS, 'utf8');

// The light theme is the first ":root {" block; the dark theme is the ":root {" inside the dark-mode media query.
function block(kind) {
  if (kind === 'light') { const s = css.indexOf(':root {'); return [s, css.indexOf('}', s)]; }
  const m = css.indexOf('@media (prefers-color-scheme: dark)');
  if (m < 0) return null;
  const s = css.indexOf(':root {', m); return [s, css.indexOf('}', s)];
}
const norm = v => {
  let x = String(v).trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(x)) x = '#' + x.slice(1).split('').map(c => c + c).join('');
  return x;
};
const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const diffs = [];
function check(kind, name, want) {
  const range = block(kind);
  if (!range) { diffs.push({ kind, name, have: '(no dark-mode block)', want }); return; }
  const [s, e] = range;
  const re = new RegExp(`(${esc(name)}\\s*:\\s*)([^;]+)(;)`);
  const body = css.slice(s, e);
  const m = body.match(re);
  if (!m) {
    if (kind === 'dark') { // not overridden in dark mode → inherits the light value
      const [ls, le] = block('light'); const lm = css.slice(ls, le).match(re);
      if (lm && norm(lm[2]) === norm(want)) return;
    }
    diffs.push({ kind, name, have: '(missing)', want }); return;
  }
  if (norm(m[2]) === norm(want)) return;
  diffs.push({ kind, name, have: m[2].trim(), want });
  if (write) css = css.slice(0, s) + body.replace(re, `$1${want}$3`) + css.slice(e);
}

for (const [name, t] of Object.entries(tokens.colors)) { check('light', name, t.light); check('dark', name, t.dark); }
for (const [name, t] of Object.entries(tokens.sizes)) check('light', name, `${t.px}px`);

if (!diffs.length) { console.log('styles.css matches the Figma tokens.'); process.exit(0); }
for (const d of diffs) console.log(`${d.kind.padEnd(5)} ${d.name.padEnd(16)} code: ${String(d.have).padEnd(12)} figma: ${d.want}`);
const missing = diffs.filter(d => d.have === '(missing)' || d.have === '(no dark-mode block)');
if (write) {
  fs.writeFileSync(CSS, css);
  console.log(`\nUpdated ${diffs.length - missing.length} value(s) in styles.css.` + (missing.length ? ` ${missing.length} variable(s) are missing from styles.css and must be added by hand.` : ''));
} else {
  console.log(`\n${diffs.length} difference(s). Run "node tools/tokens.js --write" to apply the Figma values.`);
  process.exit(1);
}
