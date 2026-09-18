import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { householdInstall } from './helpers/install.mjs';
import { makeKeyPair, signJwt, fakeFetch } from './helpers/jwt.mjs';
import { createAccessVerifier } from '../src/auth.mjs';
import { createApp, SECURITY_HEADERS } from '../src/server.mjs';
import { validateConfig } from '../src/config.mjs';
import { createSources } from '../src/sources/index.mjs';
import { loadCatalogue } from '../src/catalogue.mjs';

const TEAM = 'team.cloudflareaccess.com';
const key = makeKeyPair('k1');
const install = householdInstall();
install.writeGroupFile('home', 'agent-card.json', JSON.stringify({ name: 'Home', iconUrl: 'a.png', 'x-profile': { emoji: '🏠' } }));
install.writeGroupFile('home', 'a.png', 'PNGDATA');
install.close();

let server;
let base;
before(async () => {
  const config = validateConfig({
    nanoclawDir: install.dir,
    ncl: '/bin/false',
    access: { teamDomain: TEAM, aud: 'aud' },
    users: { 'owner@x.com': 'wa:owner', 'spouse@x.com': 'wa:spouse', 'stranger@x.com': 'wa:stranger' },
    hiddenGroups: ['eval'],
  }, '/');
  const verifier = createAccessVerifier({ teamDomain: TEAM, aud: 'aud', fetchImpl: fakeFetch({ keys: [key.jwk] }) });
  const app = createApp({ config, sources: createSources(config), plugins: [], catalogue: loadCatalogue([]), verifier, log: () => {} });
  server = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
  fs.rmSync(install.dir, { recursive: true, force: true });
});

const token = (email) => signJwt({ iss: `https://${TEAM}`, aud: ['aud'], email, exp: Date.now() / 1000 + 300 }, key);
const get = (path, email, init = {}) => fetch(base + path, { ...init, headers: email ? { 'cf-access-jwt-assertion': token(email) } : {} });

test('healthz needs no auth', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('no token is 403 with security headers', async () => {
  const res = await get('/');
  assert.equal(res.status, 403);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v);
});

test('spouse sees only Home', async () => {
  const html = await (await get('/', 'spouse@x.com')).text();
  assert.ok(html.includes('/agents/home'));
  assert.ok(!html.includes('/agents/ausie'));
  assert.equal((await get('/agents/ausie', 'spouse@x.com')).status, 404);
  assert.equal((await get('/agents/eval', 'spouse@x.com')).status, 404);
});

test('owner sees hidden groups and profiles render', async () => {
  assert.equal((await get('/agents/eval', 'owner@x.com')).status, 200);
  const res = await get('/agents/home', 'owner@x.com');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('Home'));
  assert.ok(html.includes("Couldn't load right now"), 'routines fail because ncl is /bin/false');
});

test('icon is served for visible agents', async () => {
  const res = await get('/agents/home/icon', 'spouse@x.com');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(await res.text(), 'PNGDATA');
  assert.equal((await get('/agents/ausie/icon', 'owner@x.com')).status, 404);
});

test('known email without groups gets the empty state', async () => {
  const html = await (await get('/', 'stranger@x.com')).text();
  assert.ok(html.includes('No agents yet'));
});

test('unknown email gets the no-agents page', async () => {
  const res = await get('/', 'nobody@x.com');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('No agents yet'));
});

test('POST is 405, unknown path is 404', async () => {
  assert.equal((await get('/', 'owner@x.com', { method: 'POST' })).status, 405);
  assert.equal((await get('/nope', 'owner@x.com')).status, 404);
});
