// Discord gateway bot controls for one server's Integrations tab.
import { toast } from '../lib/toast.js';
import { withBusy } from '../lib/loading.js';

const root = document.getElementById('ig-bot-root');
if (root) init(root);

function init(root) {
  const serverId = root.dataset.serverId;
  const admin = root.dataset.admin === '1';
  const el = (id) => document.getElementById(id);

  async function request(path, method = 'GET', body) {
    const response = await fetch(`/api/servers/${serverId}/integrations/discord-bot${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
    return data;
  }

  function render(next) {
    const bot = next.bot || {};
    const binding = next.binding || {};
    const status = el('ig-bot-root').querySelector('[data-bot-status]');
    status.textContent = bot.running ? 'Connected' : bot.configured ? 'Stopped' : 'Not configured';
    status.classList.toggle('badge-ok', Boolean(bot.running));
    status.classList.toggle('badge-muted', !bot.running);
    el('ig-bot-token').value = '';
    el('ig-bot-guild').value = bot.guildId || '';
    el('ig-bot-admin-role').value = bot.adminRoleId || '';
    el('ig-bot-mod-role').value = bot.modRoleId || '';
    el('ig-bot-autostart').checked = bot.autoStart !== false;
    el('ig-bot-enabled').checked = Boolean(binding.enabled);
    el('ig-bot-channel').value = binding.channelId || '';
    el('ig-bot-relay-enabled').checked = binding.relayEnabled !== false;
    el('ig-bot-relay-channel').value = binding.relayChannelId || '';
    for (const select of root.querySelectorAll('[data-bot-permission]')) {
      select.value = next.permissions?.[select.dataset.botPermission] || 'admin';
    }
    for (const checkbox of root.querySelectorAll('[data-bot-event]')) {
      const event = binding.events?.[checkbox.dataset.botEvent];
      checkbox.checked = Boolean(event?.enabled);
      const input = root.querySelector(`[data-bot-template="${checkbox.dataset.botEvent}"]`);
      if (input) input.value = event?.template || '';
    }
  }

  function bindingPayload() {
    return {
      enabled: el('ig-bot-enabled').checked,
      channelId: el('ig-bot-channel').value.trim(),
      relayEnabled: el('ig-bot-relay-enabled').checked,
      relayChannelId: el('ig-bot-relay-channel').value.trim(),
    };
  }

  function eventsPayload() {
    const events = {};
    for (const checkbox of root.querySelectorAll('[data-bot-event]')) {
      const key = checkbox.dataset.botEvent;
      events[key] = {
        enabled: checkbox.checked,
        template: root.querySelector(`[data-bot-template="${key}"]`)?.value || '',
      };
    }
    return events;
  }

  async function load() {
    try {
      render(await request());
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  }

  async function action(button, label, fn) {
    try {
      await withBusy(button, label, fn);
    } catch (error) {
      toast(error.message, { kind: 'error', timeout: 8000 });
    }
  }

  el('ig-bot-verify')?.addEventListener('click', (event) => action(event.currentTarget, 'Verifying…', async () => {
    const token = el('ig-bot-token').value.trim();
    if (!token) throw new Error('Paste a bot token first.');
    const result = await request('/verify-token', 'POST', { token });
    toast(`Token valid for ${result.bot.username}. Invite link is ready in the response.`);
  }));

  el('ig-bot-save-global')?.addEventListener('click', (event) => action(event.currentTarget, 'Saving…', async () => {
    const token = el('ig-bot-token').value.trim();
    const result = await request('/global', 'PUT', {
      ...(token ? { token } : {}),
      guildId: el('ig-bot-guild').value.trim(),
      adminRoleId: el('ig-bot-admin-role').value.trim(),
      modRoleId: el('ig-bot-mod-role').value.trim(),
      autoStart: el('ig-bot-autostart').checked,
    });
    render(result);
    toast('Global Discord bot setup saved.');
  }));

  el('ig-bot-save-binding')?.addEventListener('click', (event) => action(event.currentTarget, 'Saving…', async () => {
    render(await request('/binding', 'PUT', { ...bindingPayload(), events: eventsPayload() }));
    toast('Discord channel binding saved.');
  }));

  el('ig-bot-save-events')?.addEventListener('click', (event) => action(event.currentTarget, 'Saving…', async () => {
    render(await request('/binding', 'PUT', { ...bindingPayload(), events: eventsPayload() }));
    toast('Discord event templates saved.');
  }));

  el('ig-bot-save-permissions')?.addEventListener('click', (event) => action(event.currentTarget, 'Saving…', async () => {
    const permissions = {};
    for (const select of root.querySelectorAll('[data-bot-permission]')) permissions[select.dataset.botPermission] = select.value;
    render(await request('/permissions', 'PUT', { permissions }));
    toast('Global command permissions saved.');
  }));

  el('ig-bot-start')?.addEventListener('click', (event) => action(event.currentTarget, 'Starting…', async () => {
    render(await request('/start', 'POST', {}));
    toast('Discord bot started.');
  }));

  el('ig-bot-stop')?.addEventListener('click', (event) => action(event.currentTarget, 'Stopping…', async () => {
    render(await request('/stop', 'POST', {}));
    toast('Discord bot stopped.');
  }));

  el('ig-bot-test')?.addEventListener('click', (event) => action(event.currentTarget, 'Sending…', async () => {
    await request('/test-message', 'POST', {});
    toast('Test message sent to the bound channel.');
  }));

  el('ig-bot-reset')?.addEventListener('click', (event) => action(event.currentTarget, 'Resetting…', async () => {
    if (!window.confirm('Reset the global Discord bot and disable every server binding? Existing webhooks are kept.')) return;
    render(await request('/reset', 'POST', {}));
    toast('Global Discord bot configuration reset.');
  }));

  setInterval(async () => {
    if (document.visibilityState === 'hidden') return;
    try { render(await request()); } catch { /* retain the last known state */ }
  }, 20000);

  if (!admin) root.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
  load();
}
