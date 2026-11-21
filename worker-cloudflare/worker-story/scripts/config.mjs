#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
export async function runtime(configRoot = root) {
  const result = await build({ entryPoints: [path.join(configRoot, 'src/config.ts')], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
export async function lockProfiles(configRoot = root) {
  const mod = await runtime(configRoot);
  const actual = await mod.fingerprints();
  const file = path.join(configRoot, 'config/story-profiles.lock.json');
  const existing = JSON.parse(await fs.readFile(file, 'utf8'));
  if (existing.schema_version !== 1) throw new Error('不支持的指纹锁格式');
  for (const [version, hash] of Object.entries(existing.profiles)) {
    if (actual[version] !== hash) throw new Error(`拒绝修改或删除已锁定版本 ${version}；请新增故事版本`);
  }
  const added = Object.keys(actual).filter(version => !Object.hasOwn(existing.profiles, version));
  if (added.length) {
    const temporary = file + `.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ schema_version: 1, profiles: actual }, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, file);
  }
  return added;
}
export async function check() {
  await (await runtime()).validateConfig();
  const { unstable_readConfig } = require('wrangler');
  const read = (file, remote) => unstable_readConfig({ config: file, ...(remote ? { env: 'dev' } : {}) }, { hideWarnings: true });
  const remote = read(path.join(root, 'wrangler.jsonc'), true);
  const local = read(path.join(root, 'wrangler.local.jsonc'), false);
  const upload = read(path.join(root, '../worker-upload/wrangler.jsonc'), true);
  const db = remote.d1_databases.find(x => x.binding === 'DB');
  const source = upload.d1_databases.find(x => x.binding === 'DB');
  if (!db || !source || remote.account_id !== upload.account_id || db.database_id !== source.database_id || db.database_name !== source.database_name
    || db.database_id === '00000000-0000-0000-0000-000000000000' || remote.ai?.binding !== 'AI') throw new Error('dev DB/账号必须匹配上传端，且需要 AI binding');
  for (const config of [remote, local]) {
    if (config.queues?.consumers?.length || config.queues?.producers?.length || config.triggers?.crons?.length || config.r2_buckets?.length
      || typeof config.vars.STORY_GENERATION_ENABLED !== 'boolean') throw new Error('故事 Worker 必须是手动 HTTP 触发，不使用 Queue/Cron/R2');
    if (path.resolve(root, config.d1_databases[0].migrations_dir) !== path.resolve(root, '../worker-upload/migrations')) throw new Error('必须使用唯一的共用迁移目录');
  }
  if (local.ai || local.vars.STORY_GENERATION_ENABLED !== false || local.d1_databases[0].database_id !== '00000000-0000-0000-0000-000000000000') throw new Error('本地配置不能静默调用远端 AI');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const uploadPkg = JSON.parse(await fs.readFile(path.join(root, '../worker-upload/package.json'), 'utf8'));
  if (pkg.devDependencies.wrangler !== uploadPkg.devDependencies.wrangler || require('wrangler/package.json').version !== pkg.devDependencies.wrangler) throw new Error('Wrangler 版本必须与现有项目、锁文件一致');
  return { worker: remote.name, database: db.database_name, generation_enabled: remote.vars.STORY_GENERATION_ENABLED, manual_only: true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (rest.length || !['check', 'lock'].includes(command)) throw new Error('用法：node scripts/config.mjs check|lock');
    console.log(JSON.stringify(command === 'lock' ? { added: await lockProfiles() } : await check(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
