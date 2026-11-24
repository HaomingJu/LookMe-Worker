import { it, expect } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../scripts/story.mjs';
it.each(['v2', 'v3', 'v4', 'v5', 'v5-gemma'])('真实本地HTTP %s：手动脚本 → workerd → D1摘要 → mock AI → 0600故事文件', async version => {
  const bundle = await build({ entryPoints: ['test/runtime-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const debug = await build({ entryPoints: ['../worker-debug/src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.html': 'text', '.css': 'text', '.js': 'text' } });
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'story', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-19', d1Databases: { DB: 'shared-story-test' }, outboundService: () => { throw new Error('测试禁止访问公网'); } },
    { name: 'debug', modules: true, script: debug.outputFiles[0].text, compatibilityDate: '2026-11-19', d1Databases: { DB: 'shared-story-test' }, bindings: { DEBUG_PASSWORD: 'local-debug-test' }, outboundService: () => { throw new Error('测试禁止访问公网'); } },
  ] }));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lookme-story-http-'));
  try {
    const db = await runtime.getD1Database('DB', 'story');
    for (const file of (await fs.readdir('../worker-upload/migrations')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = (await fs.readFile(`../worker-upload/migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
      for (const statement of sql.split(';').filter(x => x.trim())) await db.prepare(statement).run();
    }
    const token = 'lm_' + 'b'.repeat(64);
    await db.prepare("INSERT INTO users(user_id,created_at_ms) VALUES ('local-user',1)").run();
    await db.prepare("INSERT INTO user_tokens(token_id,user_id,token_hash,created_at_ms,expires_at_ms) VALUES ('local-token','local-user',?,1,2000000000000)")
      .bind(createHash('sha256').update(token).digest('hex')).run();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID(); ids.push(id);
      await db.prepare("INSERT INTO photos(photo_id,owner_id,client_photo_id,object_key,sha256,byte_size,width,height,source,uploaded_at_ms) VALUES (?,'local-user',?,?,?,10,1,1,'cli',?)")
        .bind(id, crypto.randomUUID(), `not-read/${id}`, 'c'.repeat(64), Date.parse('2026-11-21T00:00:00Z') + i).run();
      await db.prepare("INSERT INTO photo_analyses(photo_id,analysis_version,model,status,next_attempt_at_ms,provider_attempt_id,provider_submitted_at_ms,result_text,created_at_ms,updated_at_ms) VALUES (?,'v2','@cf/google/gemma-4-26b-a4b-it','succeeded',1,'local-attempt',1,'合成摘要',1,1)")
        .bind(id).run();
    }
    const tokenFile = path.join(folder, 'user.token'), out = path.join(folder, 'result.story.json');
    await fs.writeFile(tokenFile, token + '\n', { mode: 0o600 });
    const model = version === 'v5-gemma' ? '@cf/google/gemma-4-26b-a4b-it' : '@cf/qwen/qwen3.8-27b';
    const count = version.startsWith('v5') ? 2 : 3;
    const result = await run(['--base-url', (await runtime.ready).origin, '--token-file', tokenFile, '--date', '2026-11-21', '--model', model, '--story-version', version, '--confirm-model-call', '--out', out]);
    expect(result.story_count).toBe(count);
    const saved = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(saved.story_version).toBe(version); expect(saved.model).toBe(model); expect(saved.stories).toHaveLength(count);
    if (version.startsWith('v5')) expect(saved.story_count_mode).toBe('auto');
    expect(saved.stories.flatMap((s: any) => s.source_photo_ids)).toEqual(ids);
    expect(saved.stories.every((s: any) => s.panels.length === 4 && s.image_prompt)).toBe(true);
    expect(saved.day_complete).toBe(true);
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(out, 'utf8')).not.toContain(token);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM photo_analyses').first() as any).n).toBe(3);
    expect(saved.persisted).toBe(true); expect(saved.run_id).toBe(saved.request_id);
    const debugWorker = await runtime.getWorker('debug');
    const login = await debugWorker.fetch('https://localhost/api/login', { method: 'POST', headers: { Origin: 'https://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'local-debug-test' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    const list = await debugWorker.fetch('https://localhost/api/stories?user=local-user&date=2026-11-21', { headers: { Cookie: cookie } });
    const listing = await list.json() as any;
    expect(listing.runs).toHaveLength(1); expect(listing.runs[0]).toMatchObject({ run_id: saved.run_id, model, status: 'succeeded', story_count: count });
    const detail = await debugWorker.fetch(`https://localhost/api/story?user=local-user&run_id=${saved.run_id}`, { headers: { Cookie: cookie } });
    const { client_request_ms, ...serverSaved } = saved;
    expect(typeof client_request_ms).toBe('number');
    expect((await detail.json() as any).result).toEqual(serverSaved);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally { await runtime.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
}, 30000);
