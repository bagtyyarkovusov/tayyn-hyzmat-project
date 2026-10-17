import { createSign } from 'node:crypto';

type Credential = { project_id: string; client_email: string; private_key: string };
let cached: { identity: string; token: string; until: number } | undefined;
function credential(): Credential | null {
  try {
    const value = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || 'null');
    return value && /^[a-z][a-z0-9-]{4,62}$/.test(value.project_id) && typeof value.client_email === 'string' && typeof value.private_key === 'string'
      ? value : null;
  } catch { return null; }
}
export function configured(): boolean { return credential() !== null; }
export class FcmFailure extends Error {
  constructor(public readonly status: number, public readonly invalidToken = false) { super(`FCM delivery failed (${status})`); }
}
async function accessToken(account: Credential): Promise<string> {
  if (cached?.identity === account.client_email && cached.until > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` })
  });
  if (!response.ok) throw new FcmFailure(response.status);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new FcmFailure(502);
  cached = { identity: account.client_email, token: data.access_token, until: Date.now() + Math.max(0, Math.min(data.expires_in ?? 3600, 3600) - 60) * 1000 };
  return data.access_token;
}
// Only transport metadata leaves our backend. Android revalidates the event
// using its installation capability before receiving any message preview.
export async function send(token: string, eventId: string, expiresAt: Date): Promise<boolean> {
  const account = credential();
  if (!account) return false;
  const ttl = Math.max(0, Math.min(86_400, Math.floor((expiresAt.getTime() - Date.now()) / 1000)));
  if (!ttl) return false;
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${await accessToken(account)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, data: { eventId }, android: { priority: 'high', ttl: `${ttl}s` } } })
  });
  if (response.ok) return true;
  if (response.status === 401) cached = undefined;
  const body = await response.json().catch(() => null) as { error?: { details?: Array<{ errorCode?: string }> } } | null;
  const invalid = body?.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED') ?? false;
  throw new FcmFailure(response.status, invalid);
}
