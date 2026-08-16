'use strict';

// Regression tests for the authorization / path-traversal fixes:
//   - backup download and the per-server file manager are admin/operator only
//     (a read-only viewer must never reach server.properties / rcon.password)
//   - the mods content routes reject path-traversal in the `file` param
//   - the /settings and /storage pages are admin only
//   - advanced Docker overrides (extra binds mount arbitrary host paths) are
//     admin only — an operator must not be able to reach host root through them

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const app = require('./helpers/app');
const authService = require('../src/services/auth');
const { dataPath } = require('../src/storage/pathGuard');

let adminCookie;
let viewerCookie;

/** Create a user with the given role and return its session cookie string. */
async function login(username, password, role) {
  authService.createUser({ username, password, role }, { actor: 'test' });
  const r = await app.req('POST', '/login', { body: { username, password } });
  return (r.setCookie || []).map((c) => c.split(';')[0]).join('; ');
}

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  viewerCookie = await login('viewer1', 'viewerpass123', 'viewer');
  app.seedServer('srv_sec01');
});

test.after(async () => {
  await app.stop();
});

test('viewer cannot download backups (403); admin passes the gate (404 for a missing id)', async () => {
  const asViewer = await app.req('GET', '/api/backups/bk_anything/download', { cookie: viewerCookie });
  assert.equal(asViewer.status, 403);

  const asAdmin = await app.req('GET', '/api/backups/bk_anything/download', { cookie: adminCookie });
  assert.equal(asAdmin.status, 404); // gate passed, backup simply doesn't exist
});

test('viewer cannot read server files (403); admin passes the gate', async () => {
  const asViewer = await app.req('GET', '/api/servers/srv_sec01/files/read?path=server.properties', {
    cookie: viewerCookie,
  });
  assert.equal(asViewer.status, 403);

  const asAdmin = await app.req('GET', '/api/servers/srv_sec01/files/list', { cookie: adminCookie });
  assert.notEqual(asAdmin.status, 403); // gate passed (200 or a benign 404, but never forbidden)
});

test('cached mod icons are served from the protected data library', async () => {
  const dir = dataPath('library', 'icons', 'mods');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/lib_test-icon.webp`, Buffer.from('RIFF....WEBP'));
  const r = await app.req('GET', '/api/icons/mods/lib_test-icon.webp', { cookie: viewerCookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /RIFF/);
});

test('mods toggle rejects path traversal in the file param', async () => {
  const r = await app.req('POST', '/api/servers/srv_sec01/mods/toggle', {
    cookie: adminCookie,
    body: { file: '../../../panel.db', enabled: false },
  });
  assert.equal(r.status, 400);
});

test('bulk mod toggle applies every distinct filename and rejects unsafe input', async () => {
  const changed = await app.req('POST', '/api/servers/srv_sec01/mods/bulk-toggle', {
    cookie: adminCookie,
    body: { files: ['first.jar', 'second.jar'], enabled: false },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.changed, 2);
  assert.equal(changed.json.instant, 2);

  const unsafe = await app.req('POST', '/api/servers/srv_sec01/mods/bulk-toggle', {
    cookie: adminCookie,
    body: { files: ['safe.jar', '../../../panel.db'], enabled: false },
  });
  assert.equal(unsafe.status, 400);

  const duplicate = await app.req('POST', '/api/servers/srv_sec01/mods/bulk-toggle', {
    cookie: adminCookie,
    body: { files: ['safe.jar', 'safe.jar'], enabled: false },
  });
  assert.equal(duplicate.status, 400);
});

test('mods delete rejects an encoded traversal in the :file param', async () => {
  const r = await app.req('DELETE', '/api/servers/srv_sec01/mods/..%2F..%2F..%2F.session-secret', {
    cookie: adminCookie,
  });
  assert.equal(r.status, 400);
});

test('advanced Docker overrides are admin-only; plain operator updates still work', async () => {
  const operatorCookie = await login('operator1', 'operatorpass123', 'operator');
  app.seedServer('srv_sec02');

  // The exact escalation this gate exists for: an operator binding the Docker
  // socket (or any host path) into a container they control.
  const binds = await app.req('PATCH', '/api/servers/srv_sec02', {
    cookie: operatorCookie,
    body: { extraBinds: [{ hostPath: '/var/run/docker.sock', containerPath: '/var/run/docker.sock' }] },
  });
  assert.equal(binds.status, 403);

  const create = await app.req('POST', '/api/servers', {
    cookie: operatorCookie,
    body: { name: 'Op Server', type: 'VANILLA', mcVersion: 'LATEST', start: false, networkName: 'proxy' },
  });
  assert.equal(create.status, 403);

  const networks = await app.req('GET', '/api/docker/networks', { cookie: operatorCookie });
  assert.equal(networks.status, 403);

  // Overrides absent → the operator's normal powers are untouched.
  const rename = await app.req('PATCH', '/api/servers/srv_sec02', {
    cookie: operatorCookie,
    body: { name: 'Renamed by operator' },
  });
  assert.equal(rename.status, 200);
});

test('/settings and /storage pages are admin only', async () => {
  for (const path of ['/settings', '/storage']) {
    const asViewer = await app.req('GET', path, { cookie: viewerCookie });
    assert.equal(asViewer.status, 403, `${path} should be forbidden for a viewer`);

    const asAdmin = await app.req('GET', path, { cookie: adminCookie });
    assert.equal(asAdmin.status, 200, `${path} should render for an admin`);
  }
});
