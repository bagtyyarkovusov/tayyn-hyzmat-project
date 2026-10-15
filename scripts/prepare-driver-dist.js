#!/usr/bin/env node
// Vue CLI's multi-page build (see vue.config.js) puts BOTH the full SPA
// (index.html + its chunks) and the driver-only bundle (driver.html + its
// chunks) into the same dist/ folder. Capacitor's webDir has to be a
// self-contained folder with an index.html at its root, and it must not
// contain the full SPA's Vuetify/Firebase/Leaflet-laden chunks - so this
// script assembles a clean dist-driver/ from just what driver.html actually
// references, renaming driver.html -> index.html (what Capacitor's native
// shell loads).
//
// IMPORTANT: this parses driver.html's own <script>/<link> tags rather than
// copying anything matching a "driver.*" filename prefix. Capacitor plugins
// (e.g. @capacitor/geolocation) lazy-load their browser-fallback
// implementation via a dynamic import(), which webpack splits into a
// separately-named async chunk (e.g. chunk-2d230c96.js) shared with the
// index bundle - filtering by prefix alone silently drops files like that
// and produces an APK that 404s at runtime the first time that code path
// is hit.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(root, 'dist-driver');

function rimraf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

const driverHtmlPath = path.join(distDir, 'driver.html');
if (!fs.existsSync(driverHtmlPath)) {
  console.error('[prepare-driver-dist] dist/driver.html not found - run `npm run build` first.');
  process.exit(1);
}

const html = fs.readFileSync(driverHtmlPath, 'utf8');

// Every /js/... or /css/... reference in the page: covers <script src=...>,
// <link rel=stylesheet href=...>, and the rel=preload/prefetch hints alike,
// since all of them use the same href="/js/x.js" / href="/css/x.css" shape.
const referenced = new Set();
const refPattern = /\/(js|css)\/([\w.-]+\.(?:js|css))/g;
let match;
// eslint-disable-next-line no-cond-assign
while ((match = refPattern.exec(html))) {
  referenced.add(`${match[1]}/${match[2]}`);
}

if (referenced.size === 0) {
  console.error('[prepare-driver-dist] Found no /js or /css references inside driver.html - aborting.');
  process.exit(1);
}

rimraf(outDir);
fs.mkdirSync(outDir, { recursive: true });

// driver.html -> index.html (Capacitor's native shell always loads index.html)
fs.copyFileSync(driverHtmlPath, path.join(outDir, 'index.html'));

let totalBytes = 0;
for (const relPath of referenced) {
  const src = path.join(distDir, relPath);
  if (!fs.existsSync(src)) {
    console.error(`[prepare-driver-dist] driver.html references ${relPath}, but it doesn't exist in dist/ - aborting.`);
    process.exit(1);
  }
  const dest = path.join(outDir, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  totalBytes += fs.statSync(src).size;
}

// Only img/icons/ - what driver.html's favicon/manifest links actually
// reference. The rest of dist/img/ (logos, the old RV-template artwork) is
// dead weight for this bundle; public/driver.html never links to any of it.
copyDirRecursive(path.join(distDir, 'img', 'icons'), path.join(outDir, 'img', 'icons'));
if (fs.existsSync(path.join(distDir, 'manifest.json'))) {
  fs.copyFileSync(path.join(distDir, 'manifest.json'), path.join(outDir, 'manifest.json'));
}

// "Новый заказ" alert sound (services/notificationSound.js) - a plain
// public/ static file, not run through webpack, so it isn't covered by the
// /js|css/ reference scan above and needs its own explicit copy here, same
// as img/icons/.
const notificationSound = path.join(distDir, 'notification.mp3');
if (fs.existsSync(notificationSound)) {
  fs.copyFileSync(notificationSound, path.join(outDir, 'notification.mp3'));
}

console.log(
  `[prepare-driver-dist] dist-driver/ ready: ${referenced.size} referenced JS/CSS file(s), ${(totalBytes / 1024).toFixed(0)} KiB total.`
);
