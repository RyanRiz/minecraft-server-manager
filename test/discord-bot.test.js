'use strict';

require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app');
const auth = require('../src/services/auth');
const discordBot = require('../src/integrations/discordBot');
const db = require('../src/db');

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

test('/status renders the detailed server embed without a website field', async () => {
  db.run(
    "UPDATE servers SET status = 'running', mc_version = '1.21.5', env_json = ? WHERE id = ?",
    JSON.stringify({ MAX_PLAYERS: '30', MOTD: '§aWholesome Minecraft Server' }),
    'srv_bot01'
  );
  let deferred = false;
  let reply;
  await discordBot.bot.commandStatus(
    {
      deferReply: async () => {
        deferred = true;
      },
      editReply: async (payload) => {
        reply = payload;
      },
    },
    'srv_bot01'
  );
  assert.equal(deferred, true);
  const embed = reply.embeds[0].toJSON();
  const fields = Object.fromEntries(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(embed.title, 'Minecraft Server: Test Server');
  assert.match(fields.STATUS, /Online/);
  assert.match(fields.PLAYERS, /0\/30/);
  assert.equal(fields.MOTD, 'Wholesome Minecraft Server');
  assert.equal(fields.VERSION, '1.21.5');
  assert.equal(Object.hasOwn(fields, 'WEBSITE'), false);
  assert.equal(embed.thumbnail, undefined);
  assert.equal(reply.files, undefined);
});
