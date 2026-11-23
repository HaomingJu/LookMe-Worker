import type { PhotoSummary, StoryResult } from './types';
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
// 只携带固定错误码、字段路径和计数；绝不携带模型正文、实际ID或凭据。
export class StoryValidationError extends Error {
  constructor(readonly code: string, readonly field: string, readonly counts: { expected?: number; actual?: number } = {}) { super(code); }
}
function keys(x: unknown, expected: string[], field: string): asserts x is Record<string, unknown> {
  if (!record(x) || Object.keys(x).sort().join(',') !== [...expected].sort().join(',')) throw new StoryValidationError('invalid_story_fields', field);
}
function text(value: unknown, limit: number, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new StoryValidationError('invalid_story_text', field);
  if (value.length > limit) throw new StoryValidationError('story_text_too_long', field, { expected: limit, actual: value.length });
}
function refs(value: unknown, allowed: Set<string>, field: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new StoryValidationError('invalid_story_sources', field);
  if (new Set(value).size !== value.length) throw new StoryValidationError('duplicate_source_id', field);
  if (value.some(id => typeof id !== 'string' || !allowed.has(id))) throw new StoryValidationError('unknown_source_id', field);
  return value;
}
export function validateResult(value: unknown, count: number, photos: PhotoSummary[], requireAllPhotos = true): StoryResult {
  keys(value, ['daily_summary', 'stories'], '$'); text(value.daily_summary, 2400, '$.daily_summary');
  if (!Array.isArray(value.stories) || value.stories.length !== count) throw new StoryValidationError('invalid_story_count', '$.stories', { expected: count, ...(Array.isArray(value.stories) ? { actual: value.stories.length } : {}) });
  const allowed = new Set(photos.map(p => p.photo_id));
  const assigned = new Set<string>();
  let previous = -1;
  for (const [index, story] of value.stories.entries()) {
    const at = `$.stories[${index}]`;
    keys(story, ['title', 'summary', 'source_photo_ids', 'image_prompt', 'panels'], at);
    text(story.title, 100, at + '.title'); text(story.summary, 1200, at + '.summary'); text(story.image_prompt, 2400, at + '.image_prompt');
    const sources = refs(story.source_photo_ids, allowed, at + '.source_photo_ids');
    for (const id of sources) { if (assigned.has(id)) throw new StoryValidationError('duplicate_story_source', at + '.source_photo_ids'); assigned.add(id); }
    const first = Math.min(...sources.map(id => photos.findIndex(p => p.photo_id === id)));
    if (first <= previous) throw new StoryValidationError('invalid_story_order', at); previous = first;
    if (!Array.isArray(story.panels) || story.panels.length !== 4) throw new StoryValidationError('invalid_panels', at + '.panels', { expected: 4, ...(Array.isArray(story.panels) ? { actual: story.panels.length } : {}) });
    const used = new Set<string>();
    for (const [i, panel] of story.panels.entries()) {
      const panelAt = `${at}.panels[${i}]`;
      keys(panel, ['panel', 'description', 'source_photo_ids', 'image_prompt'], panelAt);
      if (panel.panel !== i + 1) throw new StoryValidationError('invalid_panel_order', panelAt + '.panel');
      text(panel.description, 500, panelAt + '.description'); text(panel.image_prompt, 1200, panelAt + '.image_prompt');
      for (const id of refs(panel.source_photo_ids, new Set(sources), panelAt + '.source_photo_ids')) used.add(id);
    }
    if (used.size !== sources.length) throw new StoryValidationError('missing_panel_sources', at + '.panels', { expected: sources.length, actual: used.size });
  }
  if (requireAllPhotos && assigned.size !== photos.length) throw new StoryValidationError('missing_story_sources', '$.stories', { expected: photos.length, actual: assigned.size });
  return value as unknown as StoryResult;
}
