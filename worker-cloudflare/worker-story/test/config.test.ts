import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonical, fingerprints, validateConfig, getProfile } from '../src/config';
import { check, lockProfiles, runtime } from '../scripts/config.mjs';
it('离线配置检查：共用D1，不接入自动管道，本地不绑定远端AI', async () => {
  const config = await check();
  expect(config).toMatchObject({ database: 'lookme-dev', manual_only: true });
  expect(typeof config.generation_enabled).toBe('boolean');
  await expect(validateConfig()).resolves.toBeUndefined();
  expect(Object.keys(await fingerprints())).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v5-gemma']);
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
    await fs.writeFile(file, JSON.stringify({ ...original, profiles: { ...original.profiles, v1: { ...original.profiles.v1, system_prompt: '改变了历史语义' } } }));
    await expect(lockProfiles(root)).rejects.toThrow('拒绝修改或删除');
    const added = { ...original, profiles: { ...original.profiles, v6: { ...original.profiles.v5, temperature: 0.3 } } };
    await fs.writeFile(file, JSON.stringify(added));
    expect(await lockProfiles(root)).toEqual(['v6']);
    expect(await lockProfiles(root)).toEqual([]);
    const withoutV1 = { ...added.profiles }; delete withoutV1.v1;
    await fs.writeFile(file, JSON.stringify({ ...added, profiles: withoutV1 }));
    await expect(lockProfiles(root)).rejects.toThrow('拒绝修改或删除');
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});

it('v1历史指纹保持不变，v2预算和等待上限固定', async () => {
  expect((await fingerprints()).v1).toBe('577805bb2af000267318bac954c43626e8259f405684eac02f098ca55cd6c77c');
  expect(await getProfile('v1')).toMatchObject({ provider_timeout_ms: 90000, max_completion_tokens: 12288 });
  expect(await getProfile('v2')).toMatchObject({ enable_thinking: false, provider_timeout_ms: 180000, max_completion_tokens: 6144 });
});

it('模型默认映射和适配器参数不合法时发布检查失败',async()=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'lookme-model-config-'));const root=path.join(parent,'worker-story');
  try{
    await fs.mkdir(root);await fs.cp('src',path.join(root,'src'),{recursive:true});await fs.cp('config',path.join(root,'config'),{recursive:true});
    await fs.cp('../shared',path.join(parent,'shared'),{recursive:true});await fs.cp('../config',path.join(parent,'config'),{recursive:true});
    const file=path.join(root,'config/story-profiles.json');const original=JSON.parse(await fs.readFile(file,'utf8'));
    for(const mutate of [
      (c:any)=>{c.model_defaults['@cf/google/gemma-4-26b-a4b-it']='v5';},
      (c:any)=>{c.model_defaults['@cf/unknown/model']='v5';},
      (c:any)=>{c.model_defaults['@cf/qwen/qwen3.8-27b']='v4';},
      (c:any)=>{c.profiles['v5-gemma'].reasoning_effort='low';},
      (c:any)=>{c.profiles.v5.default_story_count=3;},
      (c:any)=>{c.profiles.v5.model='@cf/unknown/model';},
      (c:any)=>{c.profiles.v5.story_count_mode='fixed';},
    ]){
      const changed=structuredClone(original);mutate(changed);await fs.writeFile(file,JSON.stringify(changed));
      const mod=await runtime(root);await expect(mod.fingerprints()).rejects.toThrow();
    }
  }finally{await fs.rm(parent,{recursive:true,force:true});}
});
it('旧v4指纹未变化，新模型各自拥有独立锁定配置',async()=>{
  expect((await fingerprints()).v4).toBe('da85a513309a615c593fdf80c247e931c0b042bb7bc417aff40bcbaba9a0bb57');
  expect(await getProfile('v5')).toMatchObject({story_count_mode:'auto',model:'@cf/qwen/qwen3.8-27b'});
  expect(await getProfile('v5-gemma')).toMatchObject({story_count_mode:'auto',model:'@cf/google/gemma-4-26b-a4b-it'});
  expect(await getProfile('v5')).not.toHaveProperty('default_story_count');
  expect(await getProfile('v5-gemma')).not.toHaveProperty('reasoning_effort');
});
