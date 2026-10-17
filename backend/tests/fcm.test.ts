import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import * as fcm from '../src/modules/notifications/fcm';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
});

function configure() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    project_id: `synthetic-${Date.now()}`,
    client_email: `sender-${Date.now()}@synthetic.iam.gserviceaccount.com`,
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  });
}

test('FCM transport sends only a stable event id and no message preview', async () => {
  configure();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ name: 'projects/synthetic/messages/1' }), { status: 200 });
  }) as typeof fetch;
  const sent = await fcm.send('synthetic-fcm-token', 'chat:stable-event', new Date(Date.now() + 60_000));
  assert.equal(sent, true);
  assert.equal(calls.length, 2);
  const body = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(body.message.data, { eventId: 'chat:stable-event' });
  assert.equal(body.message.notification, undefined);
  assert.equal(body.message.data.body, undefined);
});

test('FCM UNREGISTERED response is classified without exposing provider details', async () => {
  configure();
  globalThis.fetch = (async (input) => {
    if (String(input) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
  }) as typeof fetch;
  await assert.rejects(() => fcm.send('expired-token', 'order:stable-event', new Date(Date.now() + 60_000)), (error: unknown) => {
    assert.ok(error instanceof fcm.FcmFailure);
    assert.equal(error.status, 404);
    assert.equal(error.invalidToken, true);
    assert.equal(error.message, 'FCM delivery failed (404)');
    return true;
  });
});
