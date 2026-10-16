import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../backend/', import.meta.url));
const name = `tayyn-test-${randomBytes(8).toString('hex')}`;
const password = randomBytes(24).toString('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed with exit ${result.status}: ${result.error?.message || result.stderr || result.stdout || result.signal || "see output above"}`);
  return result.stdout?.trim() ?? '';
}
let created = false;
function cleanup() {
  if (created) {
    created = false;
    run('docker', ['rm', '-f', '-v', name]);
  }
}
process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
try {
  run('docker', ['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=tayyn_test', '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', 'postgres:17-alpine']);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' }).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');
  const port = run('docker', ['port', name, '5432/tcp']).split(':').at(-1);
  const env = { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/tayyn_test`, JWT_ACCESS_SECRET: randomBytes(32).toString('hex'), JWT_REFRESH_SECRET: randomBytes(32).toString('hex'), DISPOSABLE_DB_TEST: 'true' };
  for (const args of [['run', 'build'], ['exec', 'prisma', 'migrate', 'deploy'], ['exec', 'tsx', '--test', '--test-concurrency=1', 'tests/api.test.ts', 'tests/geocoder-api.test.ts']]) {
    run('pnpm', args, { env, stdio: 'inherit' });
  }
} finally {
  cleanup();
}
