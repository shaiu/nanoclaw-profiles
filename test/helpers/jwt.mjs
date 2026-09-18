import crypto from 'node:crypto';

export function makeKeyPair(kid = 'k1') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export function signJwt(payload, { privateKey, kid }, header = {}) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header })).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${sig}`;
}

export function fakeFetch(jwks, calls = []) {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => (typeof jwks === 'function' ? jwks() : jwks) };
  };
}
