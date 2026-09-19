import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AuthError } from './auth.mjs';
import { createCache } from './cache.mjs';
import { resolveViewer } from './identity.mjs';
import { buildProfile, buildSummary, computeInstallServices } from './profile.mjs';
import { resolveIconPath } from './sources/card.mjs';
import { renderHome, renderMessage, renderProfile } from './web/pages.mjs';

export const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
};

const ICON_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const HTML = 'text/html; charset=utf-8';

function send(req, res, status, body, type = HTML, extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra });
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function createApp({ config, sources, plugins, catalogue, verifier, log = console.error, now = () => new Date(), cache = createCache() }) {
  const ctxBase = () => ({ config, sources, plugins, catalogue, now: now(), log });
  const notFound = (req, res) => send(req, res, 404, renderMessage({ title: 'Not found', message: "There's nothing here." }));

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, renderMessage({ title: 'Not allowed', message: 'This page is read-only.' }), HTML, { allow: 'GET, HEAD' });
    }
    if (url.pathname === '/healthz') return send(req, res, 200, 'ok', 'text/plain; charset=utf-8');

    let email;
    try {
      ({ email } = await verifier.verify(req.headers['cf-access-jwt-assertion']));
    } catch (err) {
      if (err instanceof AuthError) {
        return send(req, res, 403, renderMessage({ title: 'Please sign in', message: 'Open this page through its usual address so you can sign in.' }));
      }
      log(`auth unavailable: ${err.message}`);
      return send(req, res, 503, renderMessage({ title: 'Sign-in check unavailable', message: 'Please try again in a minute.' }));
    }

    const viewer = resolveViewer(email, { users: config.users, hiddenGroups: config.hiddenGroups, nanoclaw: sources.nanoclaw });
    // Gate on `reachable`, not the list-page `groups`: an owner whose only groups are hidden
    // still has access (they can open those groups by direct URL) and must not be told they
    // have none. Their list page below will just render an empty grid.
    if (!viewer || viewer.reachable.length === 0) {
      return send(req, res, 200, renderMessage({ title: 'No agents yet', message: "You don't have any agents here yet. Ask the person who set this up to add you." }));
    }

    if (url.pathname === '/') {
      const agents = await Promise.all(viewer.groups.map((g) => cache.get(`summary:${g.id}`, () => buildSummary(g, ctxBase()))));
      return send(req, res, 200, renderHome({ viewer, agents }));
    }

    const m = /^\/agents\/([A-Za-z0-9._-]+)(\/icon)?\/?$/.exec(url.pathname);
    const agent = m && viewer.reachable.find((g) => g.folder === m[1]);
    if (!agent) return notFound(req, res);

    if (m[2]) {
      let icon = null;
      try {
        icon = resolveIconPath(sources.card(agent.folder));
      } catch {
        icon = null;
      }
      if (!icon) return notFound(req, res);
      const type = ICON_TYPES[path.extname(icon).toLowerCase()];
      if (!type) return notFound(req, res);
      return send(req, res, 200, fs.readFileSync(icon), type, { 'cache-control': 'private, max-age=300' });
    }

    const role = viewer.isOwner ? 'owner' : 'member';
    const installServices = await cache.get('installServices', () => computeInstallServices(ctxBase()));
    const profile = await cache.get(`profile:${agent.id}:${role}`, () =>
      buildProfile(agent, { ...ctxBase(), viewer: { isOwner: viewer.isOwner }, installServices }));
    return send(req, res, 200, renderProfile(profile, { isOwner: viewer.isOwner }));
  }

  function listen(port, host) {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((err) => {
        log(err.stack ?? String(err));
        if (!res.headersSent) send(req, res, 500, renderMessage({ title: 'Something went wrong', message: 'Please try again.' }));
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { handle, listen };
}
