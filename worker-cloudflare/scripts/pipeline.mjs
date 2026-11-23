#!/usr/bin/env node
// 固定入口：只检查文件/运行锁定工具；远端配置修改仅由 Wrangler 执行。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uploadDir = path.join(root, 'worker-upload');
const consumerDir = path.join(root, 'worker-image2txt');
let require;
for (const dir of [uploadDir, consumerDir]) {
  const candidate = createRequire(path.join(dir, 'package.json'));
  try { candidate.resolve('esbuild'); candidate.resolve('wrangler'); require = candidate; break; } catch {}
}
if (!require) throw new Error('缺少锁定工具依赖：请先在Worker目录执行npm ci');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false' };
const fail = message => { throw new Error(message); };

export async function loadAnalysisRuntime(configRoot = root) {
  const { build } = require('esbuild');
  const result = await build({ entryPoints: [path.join(configRoot, 'shared/analysis-config.ts')], bundle: true,
    write: false, platform: 'node', format: 'esm' });
  // 只打包仓库中受版本管理的配置校验代码，不访问网络或任何秘密文件。
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

export function checkTopology(upload, consumer, label) {
  const db = upload.d1_databases?.find(x => x.binding === 'DB');
  const otherDb = consumer.d1_databases?.find(x => x.binding === 'DB');
  const photos = upload.r2_buckets?.find(x => x.binding === 'PHOTOS');
  const otherPhotos = consumer.r2_buckets?.find(x => x.binding === 'PHOTOS');
  const producer = upload.queues?.producers?.find(x => x.binding === 'IMAGE2TXT_QUEUE');
  const consumers = consumer.queues?.consumers ?? [];
  if (!db || !otherDb || db.database_id !== otherDb.database_id || db.database_name !== otherDb.database_name
    || !photos || photos.bucket_name !== otherPhotos?.bucket_name) fail(`${label}: 两个 Worker 必须共用 DB/PHOTOS`);
  if (!producer || consumers.length !== 1 || producer.queue !== consumers[0].queue
    || !consumers[0].dead_letter_queue || producer.queue === consumers[0].dead_letter_queue) fail(`${label}: 生产者、消费者或DLQ配置不一致`);
  if (consumer.ai?.binding !== 'AI' || consumer.workers_dev !== false || consumer.preview_urls !== false
    || (consumer.routes ?? []).length !== 0) fail(`${label}: 分析 Worker 必须是有 AI binding 的 Queue-only Worker`);
  const vars = upload.vars ?? {};
  const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  if (typeof vars.PHOTO_ANALYSIS_ENABLED !== 'boolean' || !inRange(vars.OUTBOX_BATCH_SIZE, 1, 100)
    || !inRange(vars.OUTBOX_LEASE_SECONDS, 30, 900) || !inRange(vars.OUTBOX_RETRY_BASE_SECONDS, 1, 3600)
    || !inRange(vars.OUTBOX_RETRY_MAX_SECONDS, vars.OUTBOX_RETRY_BASE_SECONDS, 86400)) fail(`${label}: Outbox参数无效`);
  if (!Array.isArray(upload.triggers?.crons) || upload.triggers.crons.length !== 1 || !upload.triggers.crons[0]) fail(`${label}: 必须配置一个补投Cron`);
  if (consumer.limits?.cpu_ms || upload.limits?.cpu_ms) fail(`${label}: 本流程不自动调整套餐CPU预算`);
  return { database: db.database_name, database_id: db.database_id, photos_bucket: photos.bucket_name,
    queue: producer.queue, dead_letter_queue: consumers[0].dead_letter_queue, cron: upload.triggers.crons[0],
    automatic_analysis_enabled: vars.PHOTO_ANALYSIS_ENABLED };
}

export async function inspect() {
  const packages = await Promise.all([uploadDir, consumerDir].map(async dir => JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'))));
  const expectedWrangler = packages[0].devDependencies.wrangler;
  if (packages[1].devDependencies.wrangler !== expectedWrangler || require('wrangler/package.json').version !== expectedWrangler) fail('两个项目及已安装工具必须使用相同的锁定Wrangler版本；请核对锁文件并npm ci');
  const { unstable_readConfig } = require('wrangler');
  const read = (dir, local) => unstable_readConfig({ config: path.join(dir, local ? 'wrangler.local.jsonc' : 'wrangler.jsonc'),
    ...(local ? {} : { env: 'dev' }) }, { hideWarnings: true });
  const upload = read(uploadDir, false), consumer = read(consumerDir, false);
  const localUpload = read(uploadDir, true), localConsumer = read(consumerDir, true);
  if (!/^[0-9a-f]{32}$/.test(upload.account_id ?? '') || upload.account_id !== consumer.account_id) fail('dev账号配置缺失或不一致');
  const topology = checkTopology(upload, consumer, 'dev');
  checkTopology(localUpload, localConsumer, 'local');
  if (topology.database_id === '00000000-0000-0000-0000-000000000000') fail('远端配置不能使用本地占位D1 ID');
  const uMigrations = path.resolve(uploadDir, upload.d1_databases.find(x => x.binding === 'DB').migrations_dir);
  const cMigrations = path.resolve(consumerDir, consumer.d1_databases.find(x => x.binding === 'DB').migrations_dir);
  if (uMigrations !== cMigrations || uMigrations !== path.join(uploadDir, 'migrations')) fail('迁移必须只有一个来源');
  for (const [name, config] of [['upload', upload], ['consumer', consumer]]) {
    if (!config.observability?.enabled || config.observability.logs?.invocation_logs === false) fail(`${name}: 必须启用调用日志`);
  }
  const analysis = await loadAnalysisRuntime();
  await analysis.validateAnalysisConfig();
  return { upload, consumer, topology, analysis };
}

export async function lockNewProfiles(configRoot = root) {
  const runtime = await loadAnalysisRuntime(configRoot);
  const actual = await runtime.profileFingerprints();
  const file = path.join(configRoot, 'config/analysis-profiles.lock.json');
  const locked = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const [version, hash] of Object.entries(locked.profiles)) {
    if (actual[version] !== hash) fail(`拒绝覆盖/删除既有版本 ${version}；请新增分析版本`);
  }
  for (const version of locked.retired_versions) if (Object.hasOwn(actual, version)) fail(`版本 ${version} 已退役，不得重新解释`);
  const added = Object.keys(actual).filter(v => !Object.hasOwn(locked.profiles, v));
  if (!added.length) return [];
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ ...locked, profiles: actual }, null, 2) + '\n', { flag: 'wx' });
  await fs.rename(temporary, file);
  return added;
}

function wranglerArgs(dir, args) {
  return [path.join(dir, 'node_modules/wrangler/bin/wrangler.js'), ...args,
    '--config', path.join(dir, 'wrangler.jsonc'), '--env', 'dev'];
}
function run(command, args, cwd, targetEnv = env) {
  execFileSync(command, args, { cwd, env: targetEnv, stdio: 'inherit' });
}
export function deploymentCommands(config) {
  const { upload, consumer, topology } = config;
  return [
    { phase: '检查登录', dir: uploadDir, args: ['whoami'] },
    { phase: '核对已有上传Worker', dir: uploadDir, args: ['deployments', 'list'] },
    { phase: '核对已有分析Worker', dir: consumerDir, args: ['deployments', 'list'] },
    { phase: '核对输入队列', dir: uploadDir, args: ['queues', 'info', topology.queue] },
    { phase: '核对死信队列', dir: uploadDir, args: ['queues', 'info', topology.dead_letter_queue] },
    { phase: '列出待应用迁移', dir: uploadDir, args: ['d1', 'migrations', 'list', topology.database, '--remote'] },
    { phase: '应用版本化迁移', dir: uploadDir, args: ['d1', 'migrations', 'apply', topology.database, '--remote'] },
    // 先让消费者认识所有配置版本，再启用新上传及Cron。
    { phase: `发布消费者 ${consumer.name}`, dir: consumerDir, args: ['deploy'] },
    { phase: `发布生产者和Cron ${upload.name}`, dir: uploadDir, args: ['deploy'] },
    { phase: '核对消费者版本', dir: consumerDir, args: ['deployments', 'list'] },
    { phase: '核对上传版本', dir: uploadDir, args: ['deployments', 'list'] },
    { phase: '核对生产者/消费者连接', dir: uploadDir, args: ['queues', 'info', topology.queue] },
    { phase: '核对迁移记录及外键', dir: uploadDir, args: ['d1', 'execute', topology.database, '--remote', '--command', 'SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_key_check;', '--json'] },
  ];
}

export function parseBackfillOptions(args) {
  const values = {};
  const allowed = new Set(['--owner', '--version', '--max-photos', '--confirm-model-calls']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || Object.hasOwn(values, key)) fail('补跑参数未知或重复');
    if (key === '--confirm-model-calls') values[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('补跑参数缺值');
      values[key] = args[++i];
    }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values['--owner'] ?? '')) fail('补跑必须指定有效owner UUID');
  const limit = Number(values['--max-photos']);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('补跑必须指定1–100的max-photos上限');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(values['--version'] ?? '')) fail('补跑必须显式指定分析版本');
  return { owner: values['--owner'].toLowerCase(), version: values['--version'], limit, confirm: values['--confirm-model-calls'] === true };
}

export function backfillSelection(owner, version) {
  // 参数已由parseBackfillOptions约束为UUID和版本标识，不接收任意SQL或对象路径。
  return `FROM photos p WHERE p.owner_id = '${owner}' AND p.object_key LIKE 'photos/v1/${owner}/%'
    AND NOT EXISTS (SELECT 1 FROM photo_analysis_dispatch d WHERE d.photo_id=p.photo_id AND d.analysis_version='${version}')
    AND NOT EXISTS (SELECT 1 FROM photo_analyses a WHERE a.photo_id=p.photo_id AND a.analysis_version='${version}')`;
}
async function remoteSql(config, sql) {
  const text = execFileSync(process.execPath, wranglerArgs(uploadDir, ['d1', 'execute', config.topology.database,
    '--remote', '--command', sql, '--json']), { cwd: uploadDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, CLOUDFLARE_ACCOUNT_ID: config.upload.account_id } });
  const results = JSON.parse(text);
  if (!Array.isArray(results) || results.some(x => x.success !== true || !Array.isArray(x.results))) fail('D1未返回确认成功的查询结果；先核对远端，不盲重写');
  return results.flatMap(x => x.results);
}
export async function backfill(config, options) {
  await config.analysis.getAnalysisProfile(options.version);
  if (!config.topology.automatic_analysis_enabled) fail('自动投递当前关闭，未补入新任务');
  const selection = backfillSelection(options.owner, options.version);
  const candidates = await remoteSql(config, `SELECT p.photo_id ${selection} ORDER BY p.uploaded_at_ms,p.photo_id LIMIT ${options.limit + 1}`);
  if (candidates.length > options.limit) fail('符合条件的图片数超过明确上限，未修改任何数据；请缩小范围或重新确认上限');
  if (candidates.some(x => !/^[0-9a-f-]{36}$/.test(x.photo_id))) fail('远端照片ID格式异常，停止');
  console.log(JSON.stringify({ owner: options.owner, analysis_version: options.version, eligible_count: candidates.length,
    max_photos: options.limit, photo_ids: candidates.map(x => x.photo_id) }, null, 2));
  if (!options.confirm) { console.log('只读预览；确认推理额度/费用后加 --confirm-model-calls。'); return; }
  if (!candidates.length) { console.log('没有需要补投的照片；已有Outbox或分析记录不会重建。'); return; }
  const now = Date.now(), ids = candidates.map(x => `'${x.photo_id}'`).join(',');
  // INSERT SELECT在同一语句内再次检查未处理状态；响应丢失后重跑仍会排除已经写入的记录。
  const inserted = await remoteSql(config, `INSERT INTO photo_analysis_dispatch
    (photo_id,analysis_version,dispatch_after_ms,created_at_ms,updated_at_ms)
    SELECT p.photo_id,'${options.version}',${now},${now},${now} ${selection} AND p.photo_id IN (${ids})
    ON CONFLICT(photo_id,analysis_version) DO NOTHING RETURNING photo_id,analysis_version`);
  console.log(JSON.stringify({ outbox_inserted: inserted.length, records: inserted }, null, 2));
  console.log('由现有Cron/Queue处理；这里只写Outbox，不直接调用模型，不清除任何调用标记。');
}

export async function main(args) {
  const [command = 'check', ...options] = args;
  if (command === 'backfill') {
    const selected = parseBackfillOptions(options);
    await backfill(await inspect(), selected);
    return;
  }
  if (command === 'lock-profiles') {
    if (options.length) fail('lock-profiles 不接受额外参数');
    console.log('新增锁定版本：' + ((await lockNewProfiles()).join(', ') || '无'));
    return;
  }
  if (!['check', 'plan', 'deploy-dev'].includes(command)) fail('用法：pipeline.mjs check|plan|lock-profiles|deploy-dev --confirm-dev|backfill --owner UUID --version VERSION --max-photos N [--confirm-model-calls]');
  if (options.some(x => x !== '--confirm-dev')) fail('未知参数');
  const config = await inspect();
  const summary = { account_id: config.upload.account_id, upload_worker: config.upload.name,
    consumer_worker: config.consumer.name, upload_routes: config.upload.routes,
    ...config.topology, default_analysis_version: config.analysis.DEFAULT_ANALYSIS_VERSION,
    supported_analysis_versions: config.analysis.ANALYSIS_VERSIONS };
  console.log(JSON.stringify(summary, null, 2));
  if (command === 'check') { console.log('配置、版本锁及连接关系检查通过；未访问远端。'); return; }
  const steps = deploymentCommands(config);
  console.log('固定部署顺序：');
  const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
  for (const step of steps) {
    console.log(step.phase + ':');
    console.log([process.execPath, ...wranglerArgs(step.dir, step.args)].map(quote).join(' '));
  }
  if (command === 'plan') { console.log('仅展示计划，未访问或修改远端。'); return; }
  if (!options.includes('--confirm-dev')) fail('未执行远端操作：请先查看 plan，明确确认后使用 deploy-dev --confirm-dev');
  // 仅已有本项目dev资源；任何身份、已有Worker或队列检查失败都中止，不猜测资源不存在。
  // 首次资源创建不是wrangler.jsonc声明，需单独告知用户并按资源流程准备。
  for (const dir of [consumerDir, uploadDir]) {
    for (const script of ['typecheck', 'test', 'build']) run('npm', ['run', script], dir);
  }
  for (const step of steps) {
    console.log(`\n>>> ${step.phase}`);
    run(process.execPath, wranglerArgs(step.dir, step.args), step.dir, { ...env, CLOUDFLARE_ACCOUNT_ID: config.upload.account_id });
  }
  console.log('Wrangler配置与迁移已应用；未补投历史照片，也未额外上传图片或调用模型。');
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error?.status !== undefined ? `命令退出码 ${error.status}；已完成的步骤保留，先核对状态再重跑。` : error.message);
    process.exitCode = 1;
  });
}
