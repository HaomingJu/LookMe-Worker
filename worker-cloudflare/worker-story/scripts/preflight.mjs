#!/usr/bin/env node
// 只读部署预检。域名 changeset 是 Wrangler 使用的预览接口，不应用配置。
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export function checkChangeset(changeset, hosts) {
  if (!changeset || ['added', 'removed', 'updated', 'conflicting'].some(key => !Array.isArray(changeset[key]))) throw new Error('无法识别域名预览，不继续部署');
  if (changeset.conflicting.length || changeset.removed.length || changeset.updated.some(domain => domain.modified)) throw new Error('域名预览包含 DNS 冲突、移除或替换，不继续部署');
  if ([...changeset.added, ...changeset.updated].some(domain => !hosts.includes(domain.hostname))) throw new Error('域名预览超出配置范围，不继续部署');
}
export async function preflight() {
  const { unstable_readConfig } = require('wrangler');
  const config = unstable_readConfig({ config: path.join(root, 'wrangler.jsonc'), env: 'dev' }, { hideWarnings: true });
  const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const targetEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.account_id, WRANGLER_SEND_METRICS: 'false' };
  const command = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--config', path.join(root, 'wrangler.jsonc'), '--env', 'dev'],
    { cwd: root, env: targetEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString());
  const identity = command(['whoami', '--json']);
  if (!identity.loggedIn || !identity.accounts?.some(account => account.id === config.account_id)) throw new Error('登录身份不能访问配置账号');
  const routes = config.routes ?? [];
  if (!routes.length) return { worker: config.name, custom_domains: [], checked: true };
  if (routes.some(route => typeof route !== 'object' || route.custom_domain !== true || !route.zone_id)) throw new Error('本预检仅支持显式 zone_id 的自定义域配置');
  const auth = command(['auth', 'token', '--json']);
  if (!['oauth', 'api_token'].includes(auth.type) || typeof auth.token !== 'string') throw new Error('需要受支持的 OAuth/API Token 身份；不输出秘密');
  async function api(url, options = {}) {
    const response = await fetch('https://api.cloudflare.com/client/v4' + url, { ...options,
      headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error(`Cloudflare 预检失败：HTTP ${response.status}，code=${data.errors?.[0]?.code ?? 'unknown'}；不部署、不把认证失败当作资源不存在`);
    return data.result;
  }
  for (const route of routes) {
    const zone = await api('/zones/' + encodeURIComponent(route.zone_id));
    if (zone.account?.id !== config.account_id || zone.status !== 'active'
      || !(route.pattern === zone.name || route.pattern.endsWith('.' + zone.name))) throw new Error('自定义域归属或状态不符');
  }
  const domains = await api(`/accounts/${config.account_id}/workers/domains`);
  if (!Array.isArray(domains)) throw new Error('无法识别已有 Worker 域名');
  const hosts = routes.map(route => route.pattern);
  if (domains.some(domain => hosts.includes(domain.hostname) && domain.service !== config.name)) throw new Error('目标域名已属于其他 Worker，不覆盖');
  const origins = routes.map(route => ({ hostname: route.pattern, zone_id: route.zone_id }));
  const changeset = await api(`/accounts/${config.account_id}/workers/scripts/${encodeURIComponent(config.name)}/domains/changeset?replace_state=true`,
    { method: 'POST', body: JSON.stringify(origins) });
  checkChangeset(changeset, hosts);
  return { worker: config.name, custom_domains: hosts, checked: true, added: changeset.added.map(domain => domain.hostname), conflicts: 0, removed: 0 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preflight(), null, 2)); }
  catch (error) {
    console.error(error instanceof Error && !('stdout' in error) ? error.message : 'Wrangler 身份预检失败；未输出底层凭据或命令结果');
    process.exitCode = 1;
  }
}
