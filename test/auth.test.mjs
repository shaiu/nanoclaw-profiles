import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessVerifier, AuthError } from '../src/auth.mjs';
import { makeKeyPair, signJwt, fakeFetch } from './helpers/jwt.mjs';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const key = makeKeyPair('k1');
const NOW_MS = 1_800_000_000_000;
const claims = (over = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], email: 'Person@X.com', exp: NOW_MS / 1000 + 300, iat: NOW_MS / 1000, ...over });

function verifier(calls = [], keys = [key.jwk]) {
  return createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: fakeFetch({ keys }, calls), now: () => NOW_MS });
}

test('valid token returns the lowercased email and fetches the certs URL', async () => {
  const calls = [];
  assert.deepEqual(await verifier(calls).verify(signJwt(claims(), key)), { email: 'person@x.com' });
  assert.deepEqual(calls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

for (const [name, token, reason] of [
  ['missing', undefined, /missing/],
  ['malformed', 'a.b', /malformed/],
  ['expired', signJwt(claims({ exp: NOW_MS / 1000 - 120 }), key), /expired/],
  ['wrong aud', signJwt(claims({ aud: ['other'] }), key), /audience/],
  ['wrong iss', signJwt(claims({ iss: 'https://evil.example' }), key), /issuer/],
  ['no email', signJwt(claims({ email: undefined }), key), /email/],
  ['alg none', signJwt(claims(), key, { alg: 'none' }), /alg/],
  ['bad signature', signJwt(claims(), key).slice(0, -4) + 'AAAA', /signature/],
  ['foreign key', signJwt(claims(), makeKeyPair('k1')), /signature/],
  ['unknown kid', signJwt(claims(), { ...key, kid: 'k9' }), /unknown signing key/],
]) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(verifier().verify(token), (err) => err instanceof AuthError && reason.test(err.message));
  });
}

test('unknown kid refetches at most once per interval', async () => {
  const calls = [];
  const v = verifier(calls);
  await v.init();
  const bad = signJwt(claims(), { ...key, kid: 'k9' });
  await assert.rejects(v.verify(bad), AuthError);
  await assert.rejects(v.verify(bad), AuthError);
  assert.equal(calls.length, 1);
});

test('rotated key is picked up on refetch', async () => {
  const rotated = makeKeyPair('k2');
  let keys = [key.jwk];
  let t = NOW_MS;
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: fakeFetch(() => ({ keys })), now: () => t });
  await v.init();
  keys = [key.jwk, rotated.jwk];
  t += 61_000;
  const token = signJwt(claims({ exp: t / 1000 + 300 }), rotated);
  assert.deepEqual(await v.verify(token), { email: 'person@x.com' });
});

test('JWKS fetch failure is not an AuthError', async () => {
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: async () => ({ ok: false, status: 500 }), now: () => NOW_MS });
  await assert.rejects(v.verify(signJwt(claims(), key)), (err) => !(err instanceof AuthError) && /HTTP 500/.test(err.message));
});

test('concurrent verifies share an in-flight JWKS refresh', async () => {
  const calls = [];
  const delayedFetch = async (url) => {
    calls.push(url);
    await new Promise(resolve => setTimeout(resolve, 20));
    return { ok: true, status: 200, json: async () => ({ keys: [key.jwk] }) };
  };
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: delayedFetch, now: () => NOW_MS });
  const token = signJwt(claims(), key);
  const results = await Promise.all([v.verify(token), v.verify(token)]);
  assert.deepEqual(results, [{ email: 'person@x.com' }, { email: 'person@x.com' }]);
  assert.equal(calls.length, 1);
});
