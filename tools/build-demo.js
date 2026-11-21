#!/usr/bin/env node
'use strict';
/* Builds the client demo as a stand-alone static site (no server, no database).

   node tools/build-demo.js <output folder>

   The output has the tour as index.html, the staff app (demo-app.html), the guest page
   (demo-order.html) and only the files they need. It runs on any static host:
   Cloudflare Pages, GitHub Pages, Netlify… The source of truth stays in this repo;
   rebuild and push the output whenever the app changes. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2];
if (!out) { console.error('Usage: node tools/build-demo.js <output folder>'); process.exit(1); }
const OUT = path.resolve(out);
if (OUT === ROOT || OUT.startsWith(ROOT + path.sep)) { console.error('Choose an output folder outside this repo.'); process.exit(1); }

const FILES = [
  'demo.html', 'demo-app.html', 'demo-order.html', 'demo.js',
  'app.js', 'customer.js', 'shared.js', 'styles.css', 'themes/moodboard.css',
  'icons/icon-192.png', 'icons/logo-blue.png', 'icons/logo-white.png',
];
for (const f of FILES) {
  fs.mkdirSync(path.join(OUT, path.dirname(f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
// The tour is the home page.
fs.copyFileSync(path.join(ROOT, 'demo.html'), path.join(OUT, 'index.html'));
// Cloudflare Pages: basic security headers (other hosts ignore this file).
fs.writeFileSync(path.join(OUT, '_headers'), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: same-origin
`);
fs.writeFileSync(path.join(OUT, 'README.md'), `# CafeFlow demo

A try-it-yourself demo of CafeFlow, the café ordering system by Dekad Teknologies.

- **index.html**: the tour, with a live guest phone and staff tablet side by side
- **demo-app.html**: the staff app (orders, kitchen, menu, settings)
- **demo-order.html?t=5**: guest ordering by QR code, Table 5

Everything runs in the visitor's browser with sample data. There is no server, no sign-in and
nothing is sent anywhere. **Reset demo** starts over.

## Hosting

A static site: publish this folder as is.

- **Cloudflare Pages:** connect this repo, framework preset *None*, build command empty,
  output directory \`/\`.
- **GitHub Pages:** Settings → Pages → deploy from branch \`main\`, folder \`/\`.

This folder is generated from the main CafeFlow project with \`node tools/build-demo.js <folder>\`.
Don't edit it by hand; change the main project and rebuild.
`);
console.log(`Demo built in ${OUT} (${FILES.length + 3} files).`);
