// @ts-nocheck — Discord gateway and Docker/RCON interop are intentionally dynamic.
'use strict';

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  escapeMarkdown,
} = require('discord.js');
const { request: undiciRequest, Headers: UndiciHeaders } = require('undici');
const { STATUS_CODES } = require('node:http');
const { types } = require('node:util');
const db = require('../db');
const settings = require('../services/settings');
const apiKeys = require('../services/apiKeys');
const servers = require('../services/servers');
const players = require('../services/players');
const chat = require('../services/chat');
const { execCapture, inspectStatus } = require('../docker/containers');
const events = require('../events');
const { recordEvent } = events;
const { cleanText } = require('../utils/ansi');

const KIND = 'discord-bot';
const PROVIDER = 'discord-bot';
const SNOWFLAKE = /^\d{15,21}$/;
const MAX_MESSAGE = 1900;
const DEFAULT_PERMISSIONS = {
  status: 'everyone',
  players: 'everyone',
  save: 'moderator',
  broadcast: 'moderator',
  kick: 'moderator',
  start: 'admin',
  stop: 'admin',
  restart: 'admin',
  rcon: 'admin',
};
const DEFAULT_EVENTS = {
  serverStart: { enabled: true, template: '🟢 **{server}** is online' },
  serverStop: { enabled: true, template: '🔴 **{server}** is offline' },
  playerJoin: { enabled: false, template: '👋 **{player}** joined **{server}**' },
  playerLeave: { enabled: false, template: '👋 **{player}** left **{server}**' },
  playerDeath: { enabled: false, template: '💀 **{player}** died on **{server}**' },
  scheduledRestart: { enabled: true, template: '🔄 **{server}** restarting in {minutes} minute(s)' },
  backupComplete: { enabled: true, template: '💾 Backup complete for **{server}**' },
};

const SETTING_KEYS = {
  guildId: 'discord_bot_guild_id',
  adminRoleId: 'discord_bot_admin_role_id',
  modRoleId: 'discord_bot_mod_role_id',
  autoStart: 'discord_bot_auto_start',
  permissions: 'discord_bot_command_permissions',
};

const restartJobs = new Map();
function plainMotd(value, fallback) {
  const motd = cleanText(String(value || fallback || '')).replace(/&[0-9a-fk-or]/gi, '').trim();
  return motd ? motd.slice(0, 1024) : 'Not set';
}

async function safeBody(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (types.isUint8Array(value)) return value;
  if (types.isArrayBuffer(value)) return new Uint8Array(value);
  if (value instanceof URLSearchParams) return value.toString();
  if (value instanceof DataView) return new Uint8Array(value.buffer);
  // discord.js uses FormData for replies with file attachments. FormData is
  // iterable as [name, value] tuples, so treating it as a stream makes
  // Buffer.concat throw "list[0] must be a Buffer" on Node 24.
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof FormData !== 'undefined' && value instanceof FormData) return value;
  if (typeof value[Symbol.iterator] === 'function') return Buffer.concat([...value]);
  if (typeof value[Symbol.asyncIterator] === 'function') {
    return (async () => {
      const chunks = [];
      for await (const chunk of value) chunks.push(chunk);
      return Buffer.concat(chunks);
    })();
  }
  throw new TypeError('Unable to resolve Discord request body');
}

async function safeDiscordRequest(url, init) {
  const response = await undiciRequest(url, { ...init, body: await safeBody(init.body) });
  return {
    body: response.body,
    arrayBuffer: () => response.body.arrayBuffer(),
    json: () => response.body.json(),
    text: () => response.body.text(),
    get bodyUsed() { return response.body.bodyUsed; },
    headers: new UndiciHeaders(Object.fromEntries(Object.entries(response.headers))),
    status: response.statusCode,
    statusText: STATUS_CODES[response.statusCode] || '',
    ok: response.statusCode >= 200 && response.statusCode < 300,
  };
}

function cloneEvents(eventsConfig) {
  return Object.fromEntries(
    Object.entries({ ...DEFAULT_EVENTS, ...(eventsConfig || {}) }).map(([key, value]) => [
      key,
      {
        enabled: Boolean(value && value.enabled),
        template: typeof value?.template === 'string' ? value.template.slice(0, 500) : DEFAULT_EVENTS[key].template,
      },
    ])
  );
}

function cleanTemplate(value, fallback) {
  const text = String(value ?? fallback).slice(0, 500);
  return { enabled: Boolean(text.trim()), template: text };
}

function actorFor(interaction) {
  return `discord:${String(interaction.user?.id || 'unknown').slice(0, 80)}`;
}

function statusText(server) {
  const status = server?.status || 'stopped';
  return {
    running: '🟢 Online',
    starting: '🟡 Starting',
    unhealthy: '🟡 Unhealthy',
    updating: '🔵 Updating',
    crashed: '🔴 Crashed',
    'over-quota': '🔴 Over quota',
    stopped: '⚫ Stopped',
  }[status] || status;
}

function publicError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\r?\n/g, ' ')
    .slice(0, 300);
}

function parseConfig(serverId) {
  const row = db.get('SELECT * FROM integrations WHERE server_id = ? AND kind = ?', serverId, KIND);
  let config = {};
  try { config = JSON.parse(row?.config_json || '{}'); } catch { config = {}; }
  return {
    enabled: Boolean(row?.enabled),
    channelId: config.channelId || '',
    relayEnabled: config.relayEnabled !== false,
    relayChannelId: config.relayChannelId || '',
    events: cloneEvents(config.events),
  };
}

function globalConfig() {
  return {
    guildId: settings.get(SETTING_KEYS.guildId, ''),
    adminRoleId: settings.get(SETTING_KEYS.adminRoleId, ''),
    modRoleId: settings.get(SETTING_KEYS.modRoleId, ''),
    autoStart: settings.get(SETTING_KEYS.autoStart, true) !== false,
    permissions: { ...DEFAULT_PERMISSIONS, ...(settings.get(SETTING_KEYS.permissions, {}) || {}) },
    hasToken: Boolean(apiKeys.getKey(PROVIDER)),
    tokenMasked: apiKeys.maskedKey(PROVIDER),
  };
}

function assertSnowflake(value, label, optional = true) {
  if (!value && optional) return;
  if (!SNOWFLAKE.test(String(value))) {
    const error = new Error(`${label} must be a Discord Snowflake`);
    error.status = 400;
    throw error;
  }
}

function collectBindings(exceptServerId) {
  const used = new Map();
  for (const row of db.all("SELECT server_id, config_json FROM integrations WHERE kind = 'discord-bot' AND enabled = 1")) {
    if (row.server_id === exceptServerId) continue;
    let cfg = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch { /* ignore malformed old data */ }
    for (const channelId of [cfg.channelId, cfg.relayChannelId]) {
      if (channelId) used.set(channelId, row.server_id);
    }
  }
  return used;
}

function getPublicConfig(serverId) {
  const global = globalConfig();
  const binding = parseConfig(serverId);
  return {
    ok: true,
    bot: {
      running: bot.isRunning,
      configured: Boolean(global.hasToken && global.guildId),
      connected: Boolean(bot.client?.user),
      username: bot.client?.user?.tag || null,
      guildId: global.guildId,
      adminRoleId: global.adminRoleId,
      modRoleId: global.modRoleId,
      autoStart: global.autoStart,
      hasToken: global.hasToken,
      tokenMasked: global.tokenMasked,
    },
    binding,
    permissions: global.permissions,
  };
}

function setBinding(serverId, input = {}) {
  const existing = parseConfig(serverId);
  const enabled = Boolean(input.enabled);
  const channelId = String(input.channelId || '').trim();
  const relayChannelId = String(input.relayChannelId || '').trim();
  assertSnowflake(channelId, 'Channel ID', !enabled);
  assertSnowflake(relayChannelId, 'Relay channel ID');
  if (enabled && !channelId) {
    const error = new Error('A command/notification channel is required when Discord bot is enabled');
    error.status = 400;
    throw error;
  }
  const candidates = [channelId, relayChannelId].filter(Boolean);
  if (new Set(candidates).size !== candidates.length) {
    const error = new Error('Command and relay channels must be different or leave relay blank');
    error.status = 400;
    throw error;
  }
  const used = collectBindings(serverId);
  const conflict = candidates.find((id) => used.has(id));
  if (conflict) {
    const error = new Error(`Discord channel ${conflict} is already bound to another server`);
    error.status = 409;
    throw error;
  }
  const eventsConfig = cloneEvents({ ...existing.events, ...(input.events || {}) });
  if (input.events && typeof input.events === 'object') {
    for (const key of Object.keys(DEFAULT_EVENTS)) {
      if (input.events[key]) eventsConfig[key] = cleanTemplate(input.events[key].template, DEFAULT_EVENTS[key].template);
    }
  }
  const config = { channelId, relayEnabled: input.relayEnabled !== false, relayChannelId, events: eventsConfig };
  db.run(
    `INSERT INTO integrations (server_id, kind, enabled, config_json, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(server_id, kind) DO UPDATE SET enabled = excluded.enabled,
       config_json = excluded.config_json, updated_at = excluded.updated_at`,
    serverId,
    KIND,
    enabled ? 1 : 0,
    JSON.stringify(config)
  );
  return parseConfig(serverId);
}

class DiscordBot {
  constructor() {
    this.client = null;
    this.isRunning = false;
    this.breakers = new Map();
    this.queue = new Map();
    this.lastLifecycle = new Map();
    this.unsubscribePanel = null;
    this.unsubscribePlayer = null;
  }

  async verifyToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._-]{20,200}$/.test(token)) {
      const error = new Error('Invalid Discord bot token format');
      error.status = 400;
      throw error;
    }
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const error = new Error('Discord rejected this bot token');
      error.status = 400;
      throw error;
    }
    const user = await response.json();
    return {
      bot: { id: user.id, username: user.username, avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null },
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${user.id}&permissions=84992&scope=bot%20applications.commands`,
    };
  }

  updateGlobal(input = {}) {
    const current = globalConfig();
    const token = input.token === 'KEEP_EXISTING' ? apiKeys.getKey(PROVIDER) : input.token;
    if (!token) {
      const error = new Error('Bot token is required');
      error.status = 400;
      throw error;
    }
    if (!/^[A-Za-z0-9._-]{20,200}$/.test(String(token))) {
      const error = new Error('Invalid Discord bot token format');
      error.status = 400;
      throw error;
    }
    assertSnowflake(input.guildId, 'Guild ID', false);
    assertSnowflake(input.adminRoleId, 'Admin role ID');
    assertSnowflake(input.modRoleId, 'Moderator role ID');
    apiKeys.setKey(PROVIDER, token, { actor: input.actor || 'system' });
    settings.set(SETTING_KEYS.guildId, String(input.guildId));
    settings.set(SETTING_KEYS.adminRoleId, input.adminRoleId ? String(input.adminRoleId) : '');
    settings.set(SETTING_KEYS.modRoleId, input.modRoleId ? String(input.modRoleId) : '');
    if (typeof input.autoStart === 'boolean') settings.set(SETTING_KEYS.autoStart, input.autoStart);
    return { credentialChanged: current.guildId !== String(input.guildId) || current.tokenMasked !== apiKeys.maskedKey(PROVIDER) };
  }

  updatePermissions(permissions, actor = 'system') {
    const valid = new Set(['everyone', 'moderator', 'admin']);
    const cleaned = {};
    for (const [key, value] of Object.entries(permissions || {})) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_PERMISSIONS, key) && valid.has(value)) cleaned[key] = value;
    }
    const next = { ...DEFAULT_PERMISSIONS, ...cleaned };
    settings.set(SETTING_KEYS.permissions, next);
    recordEvent({ actor, type: 'discord-bot-permissions', summary: 'Discord bot command permissions updated' });
    if (this.isRunning) this.registerCommands().catch((error) => console.warn('[discord-bot] command registration failed:', error.message));
    return next;
  }

  resolveBinding(channelId, { relay = false } = {}) {
    const rows = db.all("SELECT server_id, config_json FROM integrations WHERE kind = 'discord-bot' AND enabled = 1");
    for (const row of rows) {
      let cfg = {};
      try { cfg = JSON.parse(row.config_json || '{}'); } catch { continue; }
      if (cfg.channelId === channelId || (relay && cfg.relayEnabled !== false && (cfg.relayChannelId || cfg.channelId) === channelId)) return row.server_id;
    }
    return null;
  }

  async start() {
    if (this.isRunning || this.client) return true;
    const config = globalConfig();
    const token = apiKeys.getKey(PROVIDER);
    if (!token || !config.guildId) return false;
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
      allowedMentions: { parse: [] },
      rest: { makeRequest: safeDiscordRequest },
    });
    this.client.on('error', (error) => console.warn('[discord-bot] client error:', error.message));
    this.client.on('interactionCreate', (interaction) => this.handleInteraction(interaction).catch((error) => console.warn('[discord-bot] interaction:', error.message)));
    this.client.on('messageCreate', (message) => this.handleDiscordMessage(message).catch((error) => console.warn('[discord-bot] relay:', error.message)));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Discord bot ready timeout after 30s')), 30000);
        this.client.once('clientReady', () => {
          clearTimeout(timer);
          resolve();
        });
        this.client.login(token).catch(reject);
      });
      this.isRunning = true;
      this.subscribeEvents();
      await this.registerCommands();
      return true;
    } catch (error) {
      console.warn('[discord-bot] failed to start:', error.message);
      await this.stop();
      return false;
    }
  }

  async stop() {
    this.unsubscribePanel?.();
    this.unsubscribePlayer?.();
    this.unsubscribePanel = null;
    this.unsubscribePlayer = null;
    this.isRunning = false;
    this.breakers.clear();
    this.queue.clear();
    this.lastLifecycle.clear();
    if (this.client) {
      try { this.client.destroy(); } catch { /* already disconnected */ }
      this.client = null;
    }
  }

  subscribeEvents() {
    this.unsubscribePanel = events.onEvent((event) => this.handlePanelEvent(event));
    this.unsubscribePlayer = events.onPlayerEvent((event) => this.handlePlayerEvent(event));
  }

  async registerCommands() {
    const config = globalConfig();
    if (!this.client?.user || !config.guildId) return;
    const commands = this.commandBuilders().map((command) => command.toJSON());
    const rest = new REST({ version: '10', makeRequest: safeDiscordRequest }).setToken(apiKeys.getKey(PROVIDER));
    await rest.put(Routes.applicationGuildCommands(this.client.user.id, config.guildId), { body: commands });
  }

  commandBuilders() {
    const commands = [
      new SlashCommandBuilder().setName('status').setDescription('Show server status'),
      new SlashCommandBuilder().setName('players').setDescription('List online players'),
      new SlashCommandBuilder().setName('start').setDescription('Start the server'),
      new SlashCommandBuilder().setName('stop').setDescription('Stop the server gracefully'),
      new SlashCommandBuilder().setName('restart').setDescription('Restart the server with a warning').addIntegerOption((o) => o.setName('minutes').setDescription('Warning minutes').setMinValue(0).setMaxValue(30)),
      new SlashCommandBuilder().setName('save').setDescription('Save the world'),
      new SlashCommandBuilder().setName('broadcast').setDescription('Broadcast a message').addStringOption((o) => o.setName('message').setDescription('Message').setRequired(true)),
      new SlashCommandBuilder().setName('kick').setDescription('Kick a player').addStringOption((o) => o.setName('player').setDescription('Player name').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Reason')),
      new SlashCommandBuilder().setName('rcon').setDescription('Run an RCON command').addStringOption((o) => o.setName('command').setDescription('Command').setRequired(true)),
    ];
    const config = globalConfig();
    for (const command of commands) {
      const level = config.permissions[command.name] || 'admin';
      if (level === 'admin' && !config.adminRoleId) command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
      if (level === 'moderator' && !config.modRoleId && !config.adminRoleId) command.setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);
    }
    return commands;
  }

  hasRole(interaction, roleId) {
    if (!roleId || !interaction.member) return false;
    if (interaction.member.roles?.cache) return interaction.member.roles.cache.has(roleId);
    return Array.isArray(interaction.member.roles) && interaction.member.roles.includes(roleId);
  }

  allowed(interaction, commandName) {
    const level = globalConfig().permissions[commandName] || 'admin';
    if (level === 'everyone') return true;
    if (interaction.guild?.ownerId === interaction.user?.id) return true;
    if (interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    const config = globalConfig();
    if (config.adminRoleId && this.hasRole(interaction, config.adminRoleId)) return true;
    if (level === 'moderator' && config.modRoleId && this.hasRole(interaction, config.modRoleId)) return true;
    return false;
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const serverId = this.resolveBinding(interaction.channelId);
    if (!serverId) return interaction.reply({ content: '❌ This Discord channel is not linked to a Minecraft server.', flags: MessageFlags.Ephemeral });
    if (!this.allowed(interaction, interaction.commandName)) {
      return interaction.reply({ content: '❌ You do not have the Discord role required for this command.', flags: MessageFlags.Ephemeral });
    }
    try {
      switch (interaction.commandName) {
        case 'status': return this.commandStatus(interaction, serverId);
        case 'players': return this.commandPlayers(interaction, serverId);
        case 'start': return this.commandStart(interaction, serverId);
        case 'stop': return this.commandStop(interaction, serverId);
        case 'restart': return this.commandRestart(interaction, serverId);
        case 'save': return this.commandSave(interaction, serverId);
        case 'broadcast': return this.commandBroadcast(interaction, serverId);
        case 'kick': return this.commandKick(interaction, serverId);
        case 'rcon': return this.commandRcon(interaction, serverId);
        default: return interaction.reply({ content: 'Unknown command', flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.warn(`[discord-bot] /${interaction.commandName} failed:`, publicError(error));
      const content = `❌ ${publicError(error)}`;
      // A deferred interaction already has Discord's acknowledgement. Editing
      // that response is more reliable than a second follow-up when a command
      // (or an attachment upload) fails after the three-second deadline.
      if (interaction.deferred) return interaction.editReply({ content, embeds: [], files: [] });
      if (interaction.replied) return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      return interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  }

  async commandStatus(interaction, serverId) {
    // Acknowledge first so Discord never expires the slash-command interaction
    // while live server data is being read.
    await interaction.deferReply();
    const server = servers.getServer(serverId);
    const live = require('../services/liveCache').get(serverId);
    const playerCount = live.players?.online ?? 0;
    const playerMax = live.players?.max ?? (Number(server.env?.MAX_PLAYERS) || 20);
    const playerNames = (live.players?.names || []).map((name) => `• ${escapeMarkdown(name)}`).join('\n');
    const address = settings.publicAddress(server.port_game);
    const embed = new EmbedBuilder()
      .setTitle(`Minecraft Server: ${server.display_name}`)
      .setColor(['running', 'starting', 'unhealthy'].includes(server.status) ? 0x3fa62b : 0xe5484d)
      .addFields(
        { name: 'STATUS', value: statusText(server), inline: true },
        { name: 'PLAYERS', value: `${playerCount}/${playerMax}${playerNames ? `\n${playerNames}` : '\nNo players online'}`, inline: true },
        { name: 'MOTD', value: plainMotd(server.env?.MOTD, server.display_name), inline: false },
        {
          name: 'SERVER ADDRESS',
          value: address ? `\`${address}\`` : `Port \`${server.port_game}\` (public host not configured)`,
          inline: false,
        },
        { name: 'VERSION', value: String(server.mc_version || 'Unknown').slice(0, 1024), inline: true }
      )
      .setFooter({ text: 'Checked at' })
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  async commandPlayers(interaction, serverId) {
    await interaction.deferReply();
    const names = await players.listOnlineNames(serverId, { throwOnError: true });
    const description = names.length ? names.map((name) => `• ${escapeMarkdown(name)}`).join('\n').slice(0, 4000) : 'No players online';
    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('👥 Online Players').setDescription(description).setFooter({ text: `${names.length} player(s)` })] });
  }

  async commandStart(interaction, serverId) {
    await interaction.deferReply();
    const server = servers.getServer(serverId);
    if (['running', 'starting', 'unhealthy'].includes(server.status)) return interaction.editReply('⚠️ Server is already running or starting.');
    await servers.startServer(serverId, { actor: actorFor(interaction) });
    await interaction.editReply('🚀 Server is starting...');
  }

  async commandStop(interaction, serverId) {
    await interaction.deferReply();
    const server = servers.getServer(serverId);
    if (!['running', 'starting', 'unhealthy'].includes(server.status)) return interaction.editReply('⚠️ Server is not running.');
    await servers.stopServer(serverId, { actor: actorFor(interaction) });
    await interaction.editReply('🛑 Server is stopping...');
  }

  async commandRestart(interaction, serverId) {
    await interaction.deferReply();
    const minutes = interaction.options.getInteger('minutes') ?? 5;
    if (restartJobs.has(serverId)) return interaction.editReply('⚠️ A restart countdown is already active for this server.');
    const server = servers.getServer(serverId);
    if (!['running', 'starting', 'unhealthy'].includes(server.status)) return interaction.editReply('⚠️ Server is not running.');
    await interaction.editReply(`🔄 Restart scheduled in ${minutes} minute(s).`);
    const warning = `${minutes} minute(s)`;
    await chat.sendChat(serverId, { mode: 'say', text: `[Discord] Server restart in ${warning}`, actor: actorFor(interaction) }).catch(() => {});
    this.notifyEvent(serverId, 'scheduledRestart', { server: server.display_name, minutes }).catch(() => {});
    const timer = setTimeout(async () => {
      restartJobs.delete(serverId);
      try {
        await servers.restartServer(serverId, { actor: actorFor(interaction) });
        await this.sendToBinding(serverId, '🔄 Server restart completed.');
      } catch (error) {
        await this.sendToBinding(serverId, `❌ Server restart failed: ${publicError(error)}`);
      }
    }, minutes * 60 * 1000);
    timer.unref?.();
    restartJobs.set(serverId, timer);
  }

  async commandSave(interaction, serverId) {
    await interaction.deferReply();
    const out = await execCapture(serverId, ['rcon-cli', '--', 'save-all', 'flush']);
    if (/Unknown|incorrect|error/i.test(out)) throw new Error(out.slice(0, 250));
    await interaction.editReply('💾 World saved successfully.');
  }

  async commandBroadcast(interaction, serverId) {
    const message = String(interaction.options.getString('message') || '').replace(/[\r\n]+/g, ' ').slice(0, 512);
    await interaction.deferReply();
    await chat.sendChat(serverId, { mode: 'say', text: message, actor: actorFor(interaction) });
    await interaction.editReply(`📢 Broadcast sent: “${escapeMarkdown(message)}”`);
  }

  async commandKick(interaction, serverId) {
    const player = interaction.options.getString('player');
    const reason = interaction.options.getString('reason') || 'Kicked by a Discord moderator.';
    await interaction.deferReply();
    await players.kickPlayer(serverId, player, reason, { running: true, actor: actorFor(interaction) });
    await interaction.editReply(`👢 **${escapeMarkdown(player)}** was kicked.`);
  }

  async commandRcon(interaction, serverId) {
    const command = String(interaction.options.getString('command') || '').trim().replace(/^\//, '').slice(0, 500);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const info = await inspectStatus(serverId);
    if (!info.exists || !['running', 'starting', 'unhealthy'].includes(info.status)) throw new Error('Server is not running.');
    const output = require('../utils/ansi').stripAnsi(await execCapture(serverId, ['rcon-cli', '--', ...command.split(/\s+/)]));
    recordEvent({ serverId, actor: actorFor(interaction), type: 'rcon', summary: `Discord RCON: ${command.replace(/(password|token|key)\s+\S+/gi, '$1 ●●●')}`, details: { output: output.slice(0, 2000) } });
    await interaction.editReply(`\`\`\`\n${output.slice(0, MAX_MESSAGE)}\n\`\`\``);
  }

  async handleDiscordMessage(message) {
    if (!this.isRunning || message.author?.bot || message.system) return;
    const serverId = this.resolveBinding(message.channelId, { relay: true });
    if (!serverId || !parseConfig(serverId).relayEnabled) return;
    const now = Date.now();
    const key = `${serverId}:${message.author.id}`;
    const hits = (this.rate || new Map()).get(key) || [];
    const recent = hits.filter((stamp) => now - stamp < 10000);
    if (recent.length >= 5) return;
    recent.push(now);
    if (!this.rate) this.rate = new Map();
    this.rate.set(key, recent);
    let content = String(message.content || '').replace(/<@!?(\d+)>/g, (_, id) => message.mentions?.users?.get(id) ? `@${message.mentions.users.get(id).username}` : '@user').replace(/<@&(\d+)>/g, (_, id) => message.mentions?.roles?.get(id) ? `@${message.mentions.roles.get(id).name}` : '@role').replace(/<#(\d+)>/g, (_, id) => message.mentions?.channels?.get(id) ? `#${message.mentions.channels.get(id).name}` : '#channel').replace(/<a?:([^:>]+):\d+>/g, ':$1:').replace(/[\r\n]+/g, ' ').slice(0, 200);
    if (!content.trim()) return;
    await chat.sendChat(serverId, { mode: 'tellraw', target: '@a', text: `[Discord] ${message.author.username}: ${content}`, actor: `discord:${message.author.id}` });
  }

  async handlePanelEvent(event) {
    if (!event?.server_id) return;
    // `tellraw` is sent directly to game clients and does not create a normal
    // Minecraft chat-log entry. Relay panel-originated chat explicitly, while
    // excluding Discord-originated messages to avoid an echo loop.
    if (event.type === 'chat-sent') {
      if (String(event.actor || '').startsWith('discord:')) return;
      const text = String(event.details?.text || '').trim();
      if (!text) return;
      return this.queueChat(event.server_id, { player: `Panel: ${event.actor || 'system'}`, message: text });
    }
    const map = { started: 'serverStart', stopped: 'serverStop', 'backup-created': 'backupComplete' };
    const type = map[event.type];
    if (!type) return;
    const server = servers.getServer(event.server_id);
    if (!server) return;
    await this.notifyEvent(event.server_id, type, { server: server.display_name, summary: event.summary, actor: event.actor || 'system' });
  }

  async handlePlayerEvent(event) {
    if (!event?.serverId) return;
    const server = servers.getServer(event.serverId);
    if (!server) return;
    if (event.type === 'chat' && event.player !== '[Server]') return this.queueChat(event.serverId, event);
    const map = { join: 'playerJoin', leave: 'playerLeave', death: 'playerDeath' };
    const type = map[event.type];
    if (type) await this.notifyEvent(event.serverId, type, { server: server.display_name, player: event.player, message: event.message, killer: event.target, pvp: Boolean(event.target) });
  }

  queueChat(serverId, event) {
    const config = parseConfig(serverId);
    if (!config.enabled || !config.relayEnabled) return;
    const target = config.relayChannelId || config.channelId;
    if (!target) return;
    const pending = this.queue.get(serverId) || { count: 0, chain: Promise.resolve() };
    if (pending.count >= 40) return;
    pending.count++;
    pending.chain = pending.chain.then(() => this.sendChannel(target, `**<${escapeMarkdown(String(event.player).slice(0, 80))}>** ${escapeMarkdown(String(event.message || '').replace(/@everyone|@here/g, '(mention)').slice(0, 1850))}`)).catch(() => {}).finally(() => { pending.count--; });
    this.queue.set(serverId, pending);
  }

  async notifyEvent(serverId, type, variables = {}) {
    const config = parseConfig(serverId);
    const event = config.events[type];
    if (!config.enabled || !event?.enabled || !event.template.trim()) return false;
    if (type === 'serverStart' || type === 'serverStop') {
      const previous = this.lastLifecycle.get(serverId);
      if (previous && previous.type === type && Date.now() - previous.at < 60_000) return false;
    }
    const message = event.template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => variables[key] == null ? '' : String(variables[key])).replace(/@everyone/g, '(everyone)').replace(/@here/g, '(here)').slice(0, MAX_MESSAGE);
    const sent = await this.sendToBinding(serverId, message);
    if (sent && (type === 'serverStart' || type === 'serverStop')) this.lastLifecycle.set(serverId, { type, at: Date.now() });
    return sent;
  }

  async sendToBinding(serverId, message) {
    const config = parseConfig(serverId);
    return config.channelId ? this.sendChannel(config.channelId, message) : false;
  }

  breaker(channelId) {
    if (!this.breakers.has(channelId)) this.breakers.set(channelId, { failures: 0, openUntil: 0 });
    return this.breakers.get(channelId);
  }

  async sendChannel(channelId, content) {
    if (!this.client || !this.isRunning) return false;
    const breaker = this.breaker(channelId);
    if (breaker.openUntil > Date.now()) return false;
    try {
      const channel = await this.client.channels.fetch(channelId);
      await channel.send({ content: String(content).slice(0, MAX_MESSAGE), allowedMentions: { parse: [] } });
      breaker.failures = 0;
      return true;
    } catch (error) {
      breaker.failures++;
      if (breaker.failures >= 3) breaker.openUntil = Date.now() + 5 * 60 * 1000;
      console.warn('[discord-bot] channel send failed:', publicError(error));
      return false;
    }
  }
}

const bot = new DiscordBot();

async function autoStart() {
  if (globalConfig().autoStart) await bot.start();
}

async function reset(actor = 'system') {
  await bot.stop();
  apiKeys.deleteKey(PROVIDER, { actor });
  for (const key of Object.values(SETTING_KEYS)) settings.remove(key);
  db.run("UPDATE integrations SET enabled = 0, updated_at = datetime('now') WHERE kind = 'discord-bot'");
  for (const timer of restartJobs.values()) clearTimeout(timer);
  restartJobs.clear();
}

module.exports = {
  KIND,
  DEFAULT_PERMISSIONS,
  DEFAULT_EVENTS,
  bot,
  autoStart,
  getConfig: getPublicConfig,
  getGlobalConfig: globalConfig,
  setBinding,
  updateGlobal: (input) => bot.updateGlobal(input),
  updatePermissions: (permissions, actor) => bot.updatePermissions(permissions, actor),
  verifyToken: (token) => bot.verifyToken(token),
  start: () => bot.start(),
  stop: () => bot.stop(),
  testMessage: (serverId) => bot.sendToBinding(serverId, '🧪 Discord bot test message from Minecraft Server Manager.'),
  reset,
};
