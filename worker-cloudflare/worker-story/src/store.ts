import type { PhotoSummary, Story } from './types';
import type { StoryProfile } from './config';

export interface SavedStory extends Story { story_id: string }
export interface SavedResponse {
  run_id: string; request_id: string; persisted: true; created_at: string;
  stories: SavedStory[]; [key: string]: unknown;
}
// 同一批次ID仅用于保存和核对，不在存储错误时重新调用模型。
export async function beginRun(db: D1Database, runId: string, owner: string, date: string, version: string,
  profile: StoryProfile, inputHash: string, input: string, photos: PhotoSummary[], now: number) {
  // 每个batch只有两条语句，避免128张输入超过D1绑定变量/查询数量上限。
  const snapshots = JSON.stringify(photos.map((p, i) => ({ id: p.photo_id, summary: p.summary, position: i })));
  const results = await db.batch([
    db.prepare(`INSERT INTO story_runs(run_id,owner_id,story_date,timezone,date_basis,story_version,analysis_version,model,input_sha256,input_json,profile_json,status,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'generating',?,?)`).bind(runId, owner, date, profile.timezone, profile.date_basis,
      version, profile.analysis_version, profile.model, inputHash, input, JSON.stringify(profile), now, now),
    db.prepare(`INSERT INTO story_run_photos(owner_id,run_id,photo_id,position,summary_text)
      SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.position'),json_extract(value,'$.summary') FROM json_each(?)`)
      .bind(owner, runId, snapshots),
  ]);
  if (results.some(result => result.success !== true) || results[0].meta.changes !== 1 || results[1].meta.changes !== photos.length) throw new Error('run_registration_unconfirmed');
}
export async function finishRun(db: D1Database, owner: string, response: SavedResponse, now: number) {
  const statements = response.stories.map((story, position) => db.prepare(`INSERT INTO stories
    (story_id,owner_id,run_id,position,title,summary,image_prompt,panels_json,source_photo_ids_json,created_at_ms)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM story_runs WHERE run_id=? AND owner_id=? AND status='generating')`).bind(story.story_id, owner, response.run_id, position, story.title, story.summary,
      story.image_prompt, JSON.stringify(story.panels), JSON.stringify(story.source_photo_ids), now, response.run_id, owner));
  statements.push(db.prepare(`UPDATE story_runs SET status='succeeded',response_json=?,error_json=NULL,updated_at_ms=?
    WHERE run_id=? AND owner_id=? AND status='generating'`).bind(JSON.stringify(response), now, response.run_id, owner));
  try {
    const results = await db.batch(statements);
    if (results.at(-1)?.meta.changes !== 1) throw new Error('run_state_changed');
  } catch {
    // batch响应丢失不等于回滚：只按owner/run_id读回确认，不再INSERT、不重新推理。
    const row = await db.prepare("SELECT response_json FROM story_runs WHERE run_id=? AND owner_id=? AND status='succeeded'")
      .bind(response.run_id, owner).first<{ response_json: string }>();
    if (row?.response_json === JSON.stringify(response)) return;
    throw new Error('story_persistence_unconfirmed');
  }
}
export async function recordFailure(db: D1Database, owner: string, runId: string, error: Record<string, unknown>, now: number) {
  await db.prepare(`UPDATE story_runs SET status='needs_review',error_json=?,updated_at_ms=?
    WHERE run_id=? AND owner_id=? AND status='generating'`).bind(JSON.stringify(error), now, runId, owner).run();
}
