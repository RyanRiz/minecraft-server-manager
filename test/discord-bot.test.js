'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const auth = require('../src/services/auth');
const discordBot = require('../src/integrations/discordBot');

let adminCookie;
let operatorCookie;
let viewerCookie;

async function login(username, password, role) {
  auth.createUser({ username, password, role }, { actor: 'test' });
  const response = await app.req('POST', '/login', { body: { username, password } });
  return (response.setCookie || []).map((cookie) => cookie.split(';')[0]).join('; ');
}

test.before(async () => {
  await app.start();
  adminCookie = await app.adminCookie();
  operatorCookie = await login('discord-operator', 'operator-pass123', 'operator');
  viewerCookie = await login('discord-viewer', 'viewer-pass123', 'viewer');
  app.seedServer('srv_bot01');
  app.seedServer('srv_bot02');
});

test.after(async () => {
  await discordBot.reset('test');
  await app.stop();
});

test('Discord bot GET is safe and server Integrations renders the bot card', async () => {
  const api = await app.req('GET', '/api/servers/srv_bot01/integrations/discord-bot', { cookie: viewerCookie });
  assert.equal(api.status, 200);
  assert.equal(api.json.bot.hasToken, false);
  assert.equal(Object.prototype.hasOwnProperty.call(api.json.bot, 'token'), false);

  const page = await app.req('GET', '/servers/srv_bot01/integrations', { cookie: viewerCookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Discord bot/);
});

test('global bot mutation is admin-only and masks the stored token', async () => {
  const denied = await app.req('PUT', '/api/servers/srv_bot01/integrations/discord-bot/global', {
    cookie: operatorCookie,
    body: { token: 'A'.repeat(40), guildId: '123456789012345678' },
  });
  assert.equal(denied.status, 403);

  const saved = await app.req('PUT', '/api/servers/srv_bot01/integrations/discord-bot/global', {
    cookie: adminCookie,
    body: { token: 'A'.repeat(40), guildId: '123456789012345678', autoStart: false },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.bot.hasToken, true);
  assert.notEqual(saved.json.bot.tokenMasked, 'A'.repeat(40));
  assert.equal(saved.json.bot.guildId, '123456789012345678');
});

test('channel bindings reject cross-server conflicts and preserve relay fallback', async () => {
  const first = await app.req('PUT', '/api/servers/srv_bot01/integrations/discord-bot/binding', {
    cookie: adminCookie,
    body: { enabled: true, channelId: '234567890123456789', relayEnabled: true },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.binding.relayChannelId, '');

  const conflict = await app.req('PUT', '/api/servers/srv_bot02/integrations/discord-bot/binding', {
    cookie: adminCookie,
    body: { enabled: true, channelId: '234567890123456789' },
  });
  assert.equal(conflict.status, 409);
});

test('permissions are global and binding/event changes remain admin-only', async () => {
  const denied = await app.req('PUT', '/api/servers/srv_bot01/integrations/discord-bot/permissions', {
    cookie: operatorCookie,
    body: { permissions: { status: 'admin' } },
  });
  assert.equal(denied.status, 403);

  const saved = await app.req('PUT', '/api/servers/srv_bot01/integrations/discord-bot/permissions', {
    cookie: adminCookie,
    body: { permissions: { status: 'everyone', broadcast: 'admin' } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.permissions.broadcast, 'admin');
});

