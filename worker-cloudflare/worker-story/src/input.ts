import { getAnalysisProfile } from '../../shared/analysis-config';
import type { StoryProfile } from './config';
import { HttpError, type PhotoSummary } from './types';

export function dayBounds(date: unknown, now: number): { start: number; end: number; date: string } {
  if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'invalid_date');
  const calendar = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date) throw new HttpError(400, 'invalid_date');
  // 本版按现有调试页的北京时间上传日；2000—2099 年不涉及中国历史夏令时。
  const start = calendar - 8 * 3600000;
  if (start > now) throw new HttpError(400, 'future_date');
  return { date, start, end: start + 86400000 };
}
interface Row {
  photo_id: string; uploaded_at_ms: number; captured_at_ms: number | null;
  status: string | null; model: string | null; result_text: string | null;
}
export async function summaries(db: D1Database, owner: string, start: number, end: number, snapshot: number, profile: StoryProfile): Promise<PhotoSummary[]> {
  // 单个 SELECT 保持查询快照一致；LEFT JOIN 避免漏掉尚未分析的照片。
  const { results } = await db.prepare(`SELECT p.photo_id,p.uploaded_at_ms,p.captured_at_ms,a.status,a.model,a.result_text
    FROM photos p LEFT JOIN photo_analyses a ON a.photo_id=p.photo_id AND a.analysis_version=?
    WHERE p.owner_id=? AND p.uploaded_at_ms>=? AND p.uploaded_at_ms<? AND p.uploaded_at_ms<=?
    ORDER BY p.uploaded_at_ms,p.photo_id LIMIT ?`).bind(profile.analysis_version, owner, start, end, snapshot, profile.max_photos + 1).all<Row>();
  if (!results.length) throw new HttpError(422, 'no_photos');
  if (results.length > profile.max_photos) throw new HttpError(413, 'too_many_photos', { limit: profile.max_photos });
  const states: Record<string, number> = {};
  for (const row of results) states[row.status ?? 'missing'] = (states[row.status ?? 'missing'] ?? 0) + 1;
  if (results.some(row => row.status !== 'succeeded')) throw new HttpError(409, 'summaries_not_ready', { photo_count: results.length, states });
  const analysis = await getAnalysisProfile(profile.analysis_version);
  if (results.some(row => row.model !== analysis.model || typeof row.result_text !== 'string' || !row.result_text.trim() || row.result_text.length > 16000)) throw new HttpError(409, 'invalid_summary');
  return results.map(row => ({ photo_id: row.photo_id, uploaded_at: new Date(row.uploaded_at_ms).toISOString(),
    captured_at: row.captured_at_ms === null ? null : new Date(row.captured_at_ms).toISOString(), summary: row.result_text! }));
}
