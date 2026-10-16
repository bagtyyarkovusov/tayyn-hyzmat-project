// Run only against your development environment. Never prints credentials/tokens.
import { loadEnvFile } from 'node:process';
import { io } from 'socket.io-client';
try { loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = (process.env.TEST_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
const password = process.env.SEED_ADMIN_PASSWORD;
if (!password) throw new Error('Set SEED_ADMIN_PASSWORD, or provide the ignored local .env');
async function request(path, options = {}, expected = 200) {
  const response = await fetch(`${base}/api${path}`, options);
  if (response.status !== expected) throw new Error(`${path}: expected ${expected}, got ${response.status}`);
  return response.status === 204 ? null : response.json();
}
await request('/health');
await request('/admin/drivers', {}, 401);
const session = await request('/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone: process.env.SEED_ADMIN_PHONE || '+99360000000', password })
});
if (session.user.role !== 'ADMIN') throw new Error('Expected administrator role');
const options = { headers: { Authorization: `Bearer ${session.accessToken}` } };
const districts = await request('/districts', options);
const count = Array.isArray(districts) ? districts.length : (districts.districts || districts.data || []).length;
if (!count) throw new Error('No seeded districts returned');
await request('/admin/drivers', options);
await request('/admin/orders', options);
await request('/driver/profile', options, 403);
await new Promise((resolve, reject) => {
  const socket = io(base, { auth: { token: session.accessToken }, transports: ['websocket'], reconnection: false });
  const timer = setTimeout(() => { socket.disconnect(); reject(new Error('WebSocket connection timed out')); }, 15000);
  socket.on('connect', () => { clearTimeout(timer); socket.disconnect(); resolve(); });
  socket.on('connect_error', (error) => { clearTimeout(timer); socket.disconnect(); reject(error); });
});
await request('/auth/logout', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken: session.refreshToken })
}, 204);
console.log(`PASS ${base}: health, admin login, ${count} districts, database reads, auth/role rejection, WebSocket upgrade, logout`);
