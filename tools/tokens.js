#!/usr/bin/env node
'use strict';
/* Keeps the CSS in step with the Figma design tokens (design/tokens.json).

   node tools/tokens.js          check: list every value that differs (exit 1 if any)
   node tools/tokens.js --write  apply: copy the Figma values into the CSS

   Four places are checked, one per Figma mode:
     Dekad light     styles.css            first ":root {" block            (Color "Light", Layout "Dekad")
     Dekad dark      styles.css            ":root {" in the dark media query (Color "Dark")
     Electric light  themes/moodboard.css  ':root[data-theme="electric"] {'  (Color "Electric Light", Layout "Electric")
     Electric dark   themes/moodboard.css  the same, in the dark media query (Color "Electric Dark")
   A variable a block doesn't set is inherited (Electric dark → Electric light → Dekad dark → Dekad light),
   and "var(--x)" values are followed, the same way the browser does. No dependencies. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'design', 'tokens.json'), 'utf8'));
const write = process.argv.includes('--write');
const files = { 'styles.css': null, 'themes/moodboard.css': null };
for (const f of Object.keys(files)) files[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');

const DARK = '@media (prefers-color-scheme: dark)';
const BLOCKS = {
  dekadLight: { file: 'styles.css', open: ':root {', inDark: false, parent: null },
  dekadDark: { file: 'styles.css', open: ':root {', inDark: true, parent: 'dekadLight' },
  electricLight: { file: 'themes/moodboard.css', open: ':root[data-theme="electric"] {', inDark: false, parent: 'dekadLight' },
  electricDark: { file: 'themes/moodboard.css', open: ':root[data-theme="electric"] {', inDark: true, parent: 'electricLight', parent2: 'dekadDark' },
};
function range(kind) {
  const b = BLOCKS[kind], css = files[b.file];
  const from = b.inDark ? css.indexOf(DARK) : 0;
  if (from < 0) return null;
  const s = css.indexOf(b.open, from);
  return s < 0 ? null : [s, css.indexOf('}', s)];
}
const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
const declRe = name => new RegExp(`(^|[\\s;{])(${esc(name)}\\s*:\\s*)([^;]+)(;)`);
function own(kind, name) { // the value set in this block itself, or null
  const r = range(kind); if (!r) return null;
  const m = files[BLOCKS[kind].file].slice(r[0], r[1]).match(declRe(name));
  return m ? m[3].trim() : null;
}
function lookup(kind, name, depth = 0) { // value as the browser would compute it for this mode
  if (depth > 10) return null;
  const chain = [kind];
  if (kind === 'electricDark') chain.push('electricLight', 'dekadDark', 'dekadLight');
  else if (kind === 'electricLight') chain.push('dekadLight');
  else if (kind === 'dekadDark') chain.push('dekadLight');
  for (const k of chain) {
    const v = own(k, name);
    if (v == null) continue;
    const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    return ref ? lookup(kind, ref[1], depth + 1) : v;
  }
  return null;
}
const norm = v => {
  let x = String(v).trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(x)) x = '#' + x.slice(1).split('').map(c => c + c).join('');
  return x;
};

const diffs = [];
function check(kind, name, want) {
  const have = lookup(kind, name);
  if (have != null && norm(have) === norm(want)) return;
  diffs.push({ kind, name, have: have == null ? '(missing)' : have, want });
  if (!write) return;
  const r = range(kind), b = BLOCKS[kind];
  const direct = own(kind, name);
  if (!r || direct == null || /^var\(/.test(direct)) { diffs[diffs.length - 1].manual = true; return; }
  const css = files[b.file];
  files[b.file] = css.slice(0, r[0]) + css.slice(r[0], r[1]).replace(declRe(name), `$1$2${want}$4`) + css.slice(r[1]);
}

for (const [name, t] of Object.entries(tokens.colors)) {
  check('dekadLight', name, t.light); check('dekadDark', name, t.dark);
  check('electricLight', name, t.electricLight); check('electricDark', name, t.electricDark);
}
for (const [name, t] of Object.entries(tokens.sizes)) { check('dekadLight', name, `${t.px}px`); check('electricLight', name, `${t.electric}px`); }

if (!diffs.length) { console.log('The CSS matches the Figma tokens (Dekad and Electric, light and dark).'); process.exit(0); }
for (const d of diffs) console.log(`${d.kind.padEnd(13)} ${d.name.padEnd(16)} code: ${String(d.have).padEnd(12)} figma: ${d.want}`);
const manual = diffs.filter(d => d.manual || d.have === '(missing)');
if (write) {
  for (const [f, css] of Object.entries(files)) fs.writeFileSync(path.join(ROOT, f), css);
  console.log(`\nUpdated ${diffs.length - manual.length} value(s).` + (manual.length ? ` ${manual.length} must be changed by hand (missing, or set through var()).` : ''));
} else {
  console.log(`\n${diffs.length} difference(s). Run "node tools/tokens.js --write" to apply the Figma values.`);
  process.exit(1);
}
