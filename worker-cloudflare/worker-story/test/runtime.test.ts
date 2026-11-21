import { it, expect } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../scripts/story.mjs';
it('真实本地HTTP：手动脚本 → workerd → D1摘要 → mock AI → 0600故事文件', async () => {
  const bundle = await build({ entryPoints: ['test/runtime-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-11-19',
    d1Databases: ['DB'], outboundService: () => { throw new Error('测试禁止访问公网'); } }));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'lookme-story-http-'));
  try {
    const db = await runtime.getD1Database('DB');
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
    const result = await run(['--base-url', (await runtime.ready).origin, '--token-file', tokenFile, '--date', '2026-11-21', '--stories', '2', '--confirm-model-call', '--out', out]);
    expect(result.story_count).toBe(2);
    const saved = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(saved.model).toBe('@cf/qwen/qwen3.8-27b'); expect(saved.stories).toHaveLength(2);
    expect(saved.stories.flatMap((s: any) => s.source_photo_ids)).toEqual(ids);
    expect(saved.stories.every((s: any) => s.panels.length === 4 && s.image_prompt)).toBe(true);
    expect(saved.day_complete).toBe(true);
    expect((await fs.stat(out)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(out, 'utf8')).not.toContain(token);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM photo_analyses').first() as any).n).toBe(3);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  } finally { await runtime.dispose(); await fs.rm(folder, { recursive: true, force: true }); }
}, 30000);
