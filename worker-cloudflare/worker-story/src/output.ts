import type { PhotoSummary, StoryResult } from './types';
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
function keys(x: unknown, expected: string[]): asserts x is Record<string, unknown> {
  if (!record(x) || Object.keys(x).sort().join(',') !== expected.sort().join(',')) throw new Error('invalid_story_result');
}
function text(value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error('invalid_story_result');
}
function refs(value: unknown, allowed: Set<string>): string[] {
  if (!Array.isArray(value) || !value.length || value.length > allowed.size || new Set(value).size !== value.length
    || value.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('invalid_story_sources');
  return value;
}
export function validateResult(value: unknown, count: number, photos: PhotoSummary[]): StoryResult {
  keys(value, ['daily_summary', 'stories']); text(value.daily_summary, 2400);
  if (!Array.isArray(value.stories) || value.stories.length !== count) throw new Error('invalid_story_count');
  const allowed = new Set(photos.map(p => p.photo_id));
  const assigned = new Set<string>();
  let previous = -1;
  for (const story of value.stories) {
    keys(story, ['title', 'summary', 'source_photo_ids', 'image_prompt', 'panels']);
    text(story.title, 100); text(story.summary, 1200); text(story.image_prompt, 2400);
    const sources = refs(story.source_photo_ids, allowed);
    for (const id of sources) { if (assigned.has(id)) throw new Error('duplicate_story_source'); assigned.add(id); }
    const first = Math.min(...sources.map(id => photos.findIndex(p => p.photo_id === id)));
    if (first <= previous) throw new Error('invalid_story_order'); previous = first;
    if (!Array.isArray(story.panels) || story.panels.length !== 4) throw new Error('invalid_panels');
    const used = new Set<string>();
    for (const [i, panel] of story.panels.entries()) {
      keys(panel, ['panel', 'description', 'source_photo_ids', 'image_prompt']);
      if (panel.panel !== i + 1) throw new Error('invalid_panel_order');
      text(panel.description, 500); text(panel.image_prompt, 1200);
      for (const id of refs(panel.source_photo_ids, new Set(sources))) used.add(id);
    }
    if (used.size !== sources.length) throw new Error('missing_panel_sources');
  }
  if (assigned.size !== photos.length) throw new Error('missing_story_sources');
  return value as unknown as StoryResult;
}
