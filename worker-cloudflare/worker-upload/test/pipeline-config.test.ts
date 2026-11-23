import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTopology, deploymentCommands, inspect, lockNewProfiles, root, parseBackfillOptions, backfillSelection } from '../../scripts/pipeline.mjs';

const script = fileURLToPath(new URL('../../scripts/pipeline.mjs', import.meta.url));
describe('固定配置与Wrangler部署流程', () => {
  it('官方Wrangler解析器检查两个项目、本地/远端连接和版本锁', async () => {
    const config = await inspect();
    expect(config.topology.queue).toBe('lookme-dev-image2txt');
    expect(config.topology.cron).toBe('* * * * *');
    expect(config.topology.automatic_analysis_enabled).toBe(true);
  });
  it('部署顺序确定：迁移→消费者→生产者，配置修改没有管理API调用', async () => {
    const steps = deploymentCommands(await inspect());
    const apply = steps.findIndex(s => s.args.includes('apply'));
    const deploys = steps.flatMap((s, i) => s.args[0] === 'deploy' ? [i] : []);
    expect(apply).toBeLessThan(deploys[0]);
    expect(steps[deploys[0]].dir).toMatch(/worker-image2txt$/);
    expect(steps[deploys[1]].dir).toMatch(/worker-upload$/);
    expect(steps.filter(s => s.args[0] === 'd1').every(s => s.args.includes('--remote'))).toBe(true);
  });
  it('没有明确confirm-dev不执行任何远端命令', () => {
    try {
      execFileSync(process.execPath, [script, 'deploy-dev'], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' } });
      throw new Error('本应拒绝');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stderr.toString()).toContain('未执行远端操作');
      expect(error.stdout.toString()).not.toContain('>>> 检查登录');
    }
  });
  it('错误队列名、数据库、HTTP入口和Cron均拒绝', async () => {
    const config = await inspect();
    const copy = () => [structuredClone(config.upload), structuredClone(config.consumer)];
    let [u, c] = copy(); u.queues.producers[0].queue = 'wrong';
    expect(() => checkTopology(u, c, 'test')).toThrow();
    [u, c] = copy(); c.d1_databases[0].database_id = 'wrong';
    expect(() => checkTopology(u, c, 'test')).toThrow();
    [u, c] = copy(); c.workers_dev = true;
    expect(() => checkTopology(u, c, 'test')).toThrow();
    [u, c] = copy(); u.triggers.crons = [];
    expect(() => checkTopology(u, c, 'test')).toThrow();
  });
});


it('lock-profiles仅追加新版本，拒绝改变已有版本且失败时不改锁', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'lookme-profiles-'));
  try {
    await mkdir(path.join(temp, 'config')); await mkdir(path.join(temp, 'shared'));
    for (const file of ['config/analysis-profiles.json', 'config/analysis-profiles.lock.json', 'shared/analysis-config.ts']) {
      await copyFile(path.join(root, file), path.join(temp, file));
    }
    const sourcePath = path.join(temp, 'config/analysis-profiles.json');
    const lockPath = path.join(temp, 'config/analysis-profiles.lock.json');
    const before = await readFile(lockPath, 'utf8');
    const source = JSON.parse(await readFile(sourcePath, 'utf8'));
    const oldPrompt = source.profiles.v2.prompt;
    source.profiles.v2.prompt = '不允许同版本改写';
    await writeFile(sourcePath, JSON.stringify(source));
    await expect(lockNewProfiles(temp)).rejects.toThrow('拒绝覆盖/删除既有版本');
    expect(await readFile(lockPath, 'utf8')).toBe(before);
    source.profiles.v2.prompt = oldPrompt;
    source.profiles.v3 = { ...source.profiles.v2, prompt: '这是新的配置版本' };
    source.default_version = 'v3';
    await writeFile(sourcePath, JSON.stringify(source));
    expect(await lockNewProfiles(temp)).toEqual(['v3']);
    const after = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(after.profiles.v2).toBe(JSON.parse(before).profiles.v2);
    expect(after.profiles.v3).toMatch(/^[a-f0-9]{64}$/);
    expect(await lockNewProfiles(temp)).toEqual([]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});


describe('受限的历史补跑入口', () => {
  const owner = '48e1c078-fe29-4232-af03-f3074a580d9c';
  it('默认只预览，必须指定owner、版本和数量上限', () => {
    const args = ['--owner', owner, '--version', 'v2', '--max-photos', '14'];
    expect(parseBackfillOptions(args)).toEqual({ owner, version: 'v2', limit: 14, confirm: false });
    expect(parseBackfillOptions([...args, '--confirm-model-calls']).confirm).toBe(true);
    expect(backfillSelection(owner, 'v2')).toContain('NOT EXISTS (SELECT 1 FROM photo_analyses');
    expect(backfillSelection(owner, 'v2')).toContain('NOT EXISTS (SELECT 1 FROM photo_analysis_dispatch');
  });
  it.each([
    [], ['--owner', "'; DROP TABLE photos;--"],
    ['--owner', owner, '--version', 'v2', '--max-photos', '101'],
    ['--owner', owner, '--version', "v2'", '--max-photos', '14'],
    ['--owner', owner, '--owner', owner, '--version', 'v2', '--max-photos', '14'],
    ['--owner', owner, '--version', 'v2', '--max-photos', '14', '--force'],
  ])('无效或危险参数在访问远端前拒绝：%j', args => {
    expect(() => parseBackfillOptions(args)).toThrow();
  });
});
