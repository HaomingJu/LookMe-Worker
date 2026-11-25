import { ComicError, reply } from './common';

const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;

type Row = { story_id: string; title: string; summary: string; event_at_ms: number | null;
  run_id: string | null; result_width: number | null; result_height: number | null };

export async function daily(db: D1Database, owner: string, url: URL) {
  const values = url.searchParams.getAll('date');
  if (values.length > 1 || (values.length && !validDate(values[0])) ||
      Array.from(url.searchParams.keys()).some(key => key !== 'date')) throw new ComicError(400, 'invalid_date');
  const date = values[0] ?? (await db.prepare(`SELECT r.story_date FROM story_runs r
    WHERE r.owner_id=? AND r.status='succeeded' AND EXISTS (
      SELECT 1 FROM stories s WHERE s.owner_id=r.owner_id AND s.run_id=r.run_id)
    ORDER BY r.story_date DESC LIMIT 1`).bind(owner).first<{ story_date: string }>())?.story_date ?? null;
  if (!date) return reply({ date: null, timezone: 'Asia/Shanghai', stories: [] });
  const items = await db.prepare(`SELECT s.story_id,s.title,s.summary,
    (SELECT MIN(COALESCE(p.captured_at_ms, p.uploaded_at_ms)) FROM json_each(s.source_photo_ids_json) j
      JOIN photos p ON p.photo_id=j.value AND p.owner_id=s.owner_id) AS event_at_ms,
    c.run_id,c.result_width,c.result_height
    FROM stories s JOIN story_runs r ON r.owner_id=s.owner_id AND r.run_id=s.run_id
    LEFT JOIN comic_runs c ON c.owner_id=s.owner_id AND c.run_id=(
      SELECT x.run_id FROM comic_runs x WHERE x.owner_id=s.owner_id AND x.story_id=s.story_id AND x.status='succeeded'
        AND x.result_object_key IS NOT NULL ORDER BY x.created_at_ms DESC,x.run_id DESC LIMIT 1)
    WHERE s.owner_id=? AND r.story_date=? AND r.status='succeeded'
    ORDER BY event_at_ms DESC,r.created_at_ms DESC,s.position ASC,s.story_id ASC LIMIT 30`).bind(owner, date).all<Row>();
  return reply({ date, timezone: 'Asia/Shanghai', stories: items.results.map(row => ({
    story_id: row.story_id, title: row.title, summary: row.summary, event_at_ms: row.event_at_ms,
    comic: row.run_id ? { run_id: row.run_id, width: row.result_width, height: row.result_height } : null,
  })) });
}
