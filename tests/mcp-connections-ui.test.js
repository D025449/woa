import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this.textContent = ''; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
  async dispatch(event) { await this.listeners[event]?.(); }
}

test('actual connection UI renders names as text, labels scopes and confirms CSRF-bound revocation', async () => {
  const ids = ['mcp-connections-list', 'mcp-connections-messages', 'mcp-connections-feedback', 'mcp-connections-refresh', 'mcp-server-url'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
  const i18n = JSON.parse(fs.readFileSync(new URL('../src/public/i18n/en.json', import.meta.url)));
  const messages = { ...i18n.profile.mcp, scopeLabels: { 'workouts:read': i18n.profile.apiKeys.readScope, 'analytics:read': i18n.profile.apiKeys.analyticsScope } };
  elements['mcp-connections-messages'].textContent = JSON.stringify(messages);
  let accepted = false, revoked = false, outage = false;
  const calls = [];
  const source = fs.readFileSync(new URL('../src/public/js/mcp-connections-ui.js', import.meta.url), 'utf8')
    .replace('import confirmModal from "./confirm-modal.js";', 'const confirmModal = askConfirmation;');
  vm.runInNewContext(source, {
    document: { documentElement: { lang: 'en' }, getElementById: id => elements[id], createElement: tag => new Element(tag) },
    askConfirmation: async () => accepted,
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (options.method === 'DELETE') { revoked = true; return { ok: true }; }
      if (outage) return { ok: false, status: 503 };
      return { ok: true, status: 200, json: async () => ({ csrfToken: 'fixture-csrf', serverUrl: 'https://woa.example/mcp', data: [{
        id: '9007199254740993', client_name: '<img src=x onerror=alert(1)>', scopes: ['workouts:read', 'analytics:read', 'offline_access'],
        expires_at: '2027-01-01', last_used_at: null, status: revoked ? 'revoked' : 'active'
      }] }) };
    }
  });
  await new Promise(setImmediate);
  const row = elements['mcp-connections-list'].children[0];
  assert.equal(row.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(row.children[1].textContent, messages.scopeLabels['workouts:read'] + ' / ' + messages.scopeLabels['analytics:read']);
  assert.equal(elements['mcp-server-url'].textContent, 'https://woa.example/mcp');
  const button = row.querySelectorAll('button')[0]; await button.dispatch('click'); assert.equal(calls.length, 1);
  accepted = true; await button.dispatch('click');
  assert.equal(calls[1].path, '/api/profile/mcp-connections/9007199254740993');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'fixture-csrf');
  assert.equal(elements['mcp-connections-list'].querySelectorAll('button').length, 0);
  assert.equal(elements['mcp-connections-feedback'].textContent, messages.revokedSuccess);
  outage = true; await elements['mcp-connections-refresh'].dispatch('click');
  assert.equal(elements['mcp-connections-feedback'].textContent, messages.error);
  assert.equal(elements['mcp-connections-refresh'].disabled, false);
});
