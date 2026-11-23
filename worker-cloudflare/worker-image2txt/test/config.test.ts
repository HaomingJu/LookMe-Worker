import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import catalog from '../../config/analysis-profiles.json';
import locked from '../../config/analysis-profiles.lock.json';
import { validateAnalysisConfig, getAnalysisProfile } from '../../shared/analysis-config';

const clone = <T>(value: T): T => structuredClone(value);
async function runtime(source: any, lock: any) {
  const result = await build({ entryPoints: ['../shared/analysis-config.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: '配置测试替身', setup(context) {
      context.onLoad({ filter: /analysis-profiles(\.lock)?\.json$/ }, args => ({
        contents: JSON.stringify(args.path.endsWith('.lock.json') ? lock : source), loader: 'json',
      }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const fingerprint = (profile: any) => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(profile).sort().map(k => [k, profile[k]])))).digest('hex');

describe('版本化配置与锁', () => {
  it('仓库配置通过校验，v2参数来自JSON', async () => {
    await validateAnalysisConfig();
    expect(await getAnalysisProfile('v2')).toEqual(catalog.profiles.v2);
  });
  it('修改同版本prompt被锁拒绝，不能静默改变已有任务语义', async () => {
    const source = clone(catalog); source.profiles.v2.prompt += '不允许同版本改写';
    const module = await runtime(source, locked);
    await expect(module.validateAnalysisConfig()).rejects.toMatchObject({ code: 'analysis_profile_lock_mismatch' });
  });
  it('新增版本并锁定后，新默认值可改变，旧任务继续读取原版本', async () => {
    const source: any = clone(catalog), lock: any = clone(locked);
    source.profiles.v3 = { ...source.profiles.v2, prompt: '仅测试新版本提示词' };
    source.default_version = 'v3'; lock.profiles.v3 = fingerprint(source.profiles.v3);
    const module = await runtime(source, lock);
    await module.validateAnalysisConfig();
    expect(module.DEFAULT_ANALYSIS_VERSION).toBe('v3');
    expect(await module.getAnalysisProfile('v2')).toEqual(catalog.profiles.v2);
    expect((await module.getAnalysisProfile('v3')).prompt).toBe('仅测试新版本提示词');
  });
  it('删除已锁版本或忘记新增锁均失败', async () => {
    const source: any = clone(catalog);
    source.profiles.v3 = { ...source.profiles.v2 }; source.default_version = 'v3';
    const module = await runtime(source, locked);
    await expect(module.validateAnalysisConfig()).rejects.toThrow();
    delete source.profiles.v2;
    const missing = await runtime(source, locked);
    await expect(missing.validateAnalysisConfig()).rejects.toThrow();
  });
  it.each([{ max_completion_tokens: 0 }, { max_completion_tokens: 99999 }, { enable_thinking: 'false' },
    { adapter: 'unknown' }, { extra_field: true }, { prompt: '' }, { model: 'https://attacker.invalid' }])('非法配置不降级为默认值：%j', async change => {
    const source: any = clone(catalog); Object.assign(source.profiles.v2, change);
    await expect(runtime(source, locked)).rejects.toThrow('invalid_analysis_profile');
  });
  it('不允许重新定义已退役的Moondream v1', async () => {
    const source: any = clone(catalog); source.profiles.v1 = { ...source.profiles.v2 };
    await expect(runtime(source, locked)).rejects.toThrow('invalid_analysis_profile');
  });
});
