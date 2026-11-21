import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, fingerprints, validateConfig } from '../src/config';
import { check, lockProfiles } from '../scripts/config.mjs';
it('离线配置检查：共用D1，不接入自动管道，本地不绑定远端AI', async () => {
  expect(await check()).toMatchObject({ database: 'lookme-dev', generation_enabled: false, manual_only: true });
  await expect(validateConfig()).resolves.toBeUndefined();
  expect(Object.keys(await fingerprints())).toEqual(['v1']);
  expect(canonical({ b: { d: 1, c: 2 }, a: 3 })).toBe(canonical({ a: 3, b: { c: 2, d: 1 } }));
});
it('锁定版本不能修改或删除；新版本可追加', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'lookme-story-config-'));
  const root = path.join(parent, 'worker-story');
  try {
    await fs.mkdir(root);
    await fs.cp('src', path.join(root, 'src'), { recursive: true });
    await fs.cp('config', path.join(root, 'config'), { recursive: true });
    await fs.cp('../shared', path.join(parent, 'shared'), { recursive: true });
    await fs.cp('../config', path.join(parent, 'config'), { recursive: true });
    const file = path.join(root, 'config/story-profiles.json');
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...original, profiles: { v1: { ...original.profiles.v1, system_prompt: '改变了历史语义' } } }));
    await expect(lockProfiles(root)).rejects.toThrow('拒绝修改或删除');
    const added = { ...original, profiles: { ...original.profiles, v2: { ...original.profiles.v1, temperature: 0.3 } } };
    await fs.writeFile(file, JSON.stringify(added));
    expect(await lockProfiles(root)).toEqual(['v2']);
    expect(await lockProfiles(root)).toEqual([]);
    await fs.writeFile(file, JSON.stringify({ ...added, default_version: 'v2', profiles: { v2: added.profiles.v2 } }));
    await expect(lockProfiles(root)).rejects.toThrow('拒绝修改或删除');
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
