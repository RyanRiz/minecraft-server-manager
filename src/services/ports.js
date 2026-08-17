'use strict';

// Host-port allocation. Scheme (user-approved): game ports first-free from
// 25565, RCON = game + 1000, Bedrock UDP first-free from 19132. A port is
// "taken" if any DB server claims it OR the OS reports it in use.

const net = require('node:net');
const dgram = require('node:dgram');
const db = require('../db');
const config = require('../config');

function probe(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

function probeUdp(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.unref();
    socket.once('error', () => {
      socket.close();
      resolve(false);
    });
    socket.bind({ port, address: host, exclusive: true }, () => socket.close(() => resolve(true)));
  });
}

function dbPortsInUse() {
  const rows = db.all(
    'SELECT port_game, port_rcon, port_bedrock, extra_ports_json FROM servers WHERE deleted_at IS NULL'
  );
  const used = new Set();
  for (const r of rows) {
    used.add(r.port_game);
    used.add(r.port_rcon);
    if (r.port_bedrock) used.add(r.port_bedrock);
    for (const p of JSON.parse(r.extra_ports_json || '[]')) {
      if (p && p.hostPort) used.add(p.hostPort);
    }
  }
  // BlueMap's web-server port lives in `integrations`, not on the server row —
  // it must be unioned in too, or a fresh port allocation could collide with it.
  for (const row of db.all("SELECT config_json FROM integrations WHERE kind = 'bluemap' AND enabled = 1")) {
    const hostPort = JSON.parse(row.config_json || '{}').hostPort;
    if (hostPort) used.add(hostPort);
  }
  used.add(config.port); // never hand out the panel's own port
  return used;
}

async function isPortFree(port) {
  // undefined/null/NaN/'25565xyz' must NOT pass as free — that silently
  // skipped RCON collision validation for explicit game ports.
  if (!Number.isInteger(port)) return false;
  if (port < 1024 || port > 65535) return false;
  if (dbPortsInUse().has(port)) return false;
  return probe(port);
}

async function isUdpPortFree(port) {
  if (!Number.isInteger(port)) return false;
  if (port < 1024 || port > 65535) return false;
  if (dbPortsInUse().has(port)) return false;
  return probeUdp(port);
}

async function suggestBedrockPort() {
  const used = dbPortsInUse();
  let port = config.ports.bedrockStart;
  while (used.has(port) || !(await probeUdp(port))) {
    port += 1;
    if (port > 65000) throw new Error('No free Bedrock ports available');
  }
  return port;
}

/** Suggest a { game, rcon } pair (and bedrock when requested). */
async function suggestPorts({ withBedrock = false } = {}) {
  const used = dbPortsInUse();
  let game = config.ports.gameStart;
  for (;;) {
    const rcon = game + config.ports.rconOffset;
    if (!used.has(game) && !used.has(rcon) && (await probe(game)) && (await probe(rcon))) break;
    game += 1;
    if (game > 65000) throw new Error('No free game ports available');
  }
  const result = { game, rcon: game + config.ports.rconOffset, bedrock: null };
  if (withBedrock) result.bedrock = await suggestBedrockPort();
  return result;
}

module.exports = { isPortFree, isUdpPortFree, suggestBedrockPort, suggestPorts };
