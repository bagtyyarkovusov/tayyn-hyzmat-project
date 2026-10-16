const fs = require('node:fs');
const path = require('node:path');
const dist = path.resolve(__dirname, '../dist');
const out = path.resolve(__dirname, '../dist-driver');
if (!fs.existsSync(path.join(dist, 'driver.html'))) throw new Error('Run pnpm build:modern first');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const name of ['assets', 'brand', 'img', 'manifest.json', 'notification.mp3']) {
 if (fs.existsSync(path.join(dist, name))) fs.cpSync(path.join(dist, name), path.join(out, name), { recursive: true });
}
fs.copyFileSync(path.join(dist, 'driver.html'), path.join(out, 'index.html'));
console.log('Prepared Vite driver entry and complete asset graph. Native behavior requires separate device verification.');
