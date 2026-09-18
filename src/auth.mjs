import crypto from 'node:crypto';

export class AuthError extends Error {}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const LEEWAY_S = 60;

export function createAccessVerifier({ teamDomain, aud, fetchImpl = globalThis.fetch, now = () => Date.now(), refetchIntervalMs = 60_000 }) {
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = new Map();
  let lastFetch = -Infinity;

  async function refresh() {
    lastFetch = now();
    const res = await fetchImpl(certsUrl);
    if (!res.ok) throw new Error(`Access JWKS fetch failed: HTTP ${res.status}`);
    const body = await res.json();
    const next = new Map();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    keys = next;
  }

  async function keyFor(kid) {
    if (!keys.has(kid) && now() - lastFetch >= refetchIntervalMs) await refresh();
    return keys.get(kid);
  }

  return {
    init: refresh,
    async verify(token) {
      if (typeof token !== 'string' || !token) throw new AuthError('missing token');
      const parts = token.split('.');
      if (parts.length !== 3) throw new AuthError('malformed token');
      let header;
      let payload;
      try {
        header = decode(parts[0]);
        payload = decode(parts[1]);
      } catch {
        throw new AuthError('malformed token');
      }
      if (header.alg !== 'RS256') throw new AuthError('unsupported alg');
      const key = await keyFor(header.kid);
      if (!key) throw new AuthError('unknown signing key');
      const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
      if (!valid) throw new AuthError('bad signature');
      const t = now() / 1000;
      if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_S < t) throw new AuthError('expired');
      if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_S > t) throw new AuthError('not yet valid');
      if (payload.iss !== issuer) throw new AuthError('wrong issuer');
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.includes(aud)) throw new AuthError('wrong audience');
      if (typeof payload.email !== 'string' || !payload.email) throw new AuthError('no email claim');
      return { email: payload.email.toLowerCase() };
    },
  };
}
