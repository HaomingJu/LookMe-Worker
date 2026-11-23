import type { StoryProfile } from './config';
import type { PhotoSummary, StoryResult } from './types';
import { StoryValidationError, validateResult } from './output';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const aliasAt = (index: number) => `P${String(index + 1).padStart(3, '0')}`;
const aliasesEnabled = (profile: StoryProfile) => profile.source_reference_mode === 'panel_aliases';

export function providerPhotos(photos: PhotoSummary[], profile: StoryProfile): PhotoSummary[] {
  return aliasesEnabled(profile) ? photos.map((photo, index) => ({ ...photo, photo_id: aliasAt(index) })) : photos;
}
function schemaObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('invalid_story_reference_schema');
  return value;
}
function schemaParts(schema: Record<string, unknown>) {
  const stories = schemaObject(schemaObject(schema.properties).stories);
  const story = schemaObject(stories.items);
  const props = schemaObject(story.properties);
  const panel = schemaObject(schemaObject(props.panels).items);
  const refs = schemaObject(schemaObject(panel.properties).source_photo_ids);
  return { stories, story, props, refs };
}
export function validateReferenceSchema(profile: StoryProfile): void {
  if (!aliasesEnabled(profile)) return;
  const { story, props, refs } = schemaParts(profile.response_schema);
  if (Object.hasOwn(props, 'source_photo_ids') || !Array.isArray(story.required) || story.required.includes('source_photo_ids')
    || refs.type !== 'array' || schemaObject(refs.items).type !== 'string') throw new Error('invalid_story_reference_schema');
}
export function responseSchema(profile: StoryProfile, count: number | null, photos: PhotoSummary[]): Record<string, unknown> {
  if (!aliasesEnabled(profile)) return profile.response_schema; // v1/v2 的请求协议不变。
  const schema = structuredClone(profile.response_schema);
  const { stories, refs } = schemaParts(schema);
  stories.minItems = count ?? 1;
  stories.maxItems = count ?? Math.min(profile.max_stories, photos.length);
  refs.items = { type: 'string', enum: photos.map((_, index) => aliasAt(index)) };
  refs.maxItems = photos.length; // 重复项由服务端检查，不依赖供应商对 uniqueItems 的支持。
  return schema;
}
function keys(value: unknown, expected: string[], field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new StoryValidationError('invalid_story_fields', field);
}
// 只做可证实的映射和排序；不猜测非法ID，不补图、不删引用、不重调模型。
export function decodeResult(value: unknown, count: number | null, photos: PhotoSummary[], profile: StoryProfile): StoryResult {
  if (!aliasesEnabled(profile)) {
    if (count === null) throw new Error('auto_count_requires_alias_protocol');
    return validateResult(value, count, photos);
  }
  keys(value, ['daily_summary', 'stories'], '$');
  const maxCount = Math.min(profile.max_stories, photos.length);
  if (!Array.isArray(value.stories) || (count === null ? value.stories.length < 1 || value.stories.length > maxCount : value.stories.length !== count)) {
    throw new StoryValidationError('invalid_story_count', '$.stories', { ...(count === null ? {} : { expected: count }), ...(Array.isArray(value.stories) ? { actual: value.stories.length } : {}) });
  }
  const byAlias = new Map(photos.map((photo, index) => [aliasAt(index), photo.photo_id]));
  const positions = new Map(photos.map((photo, index) => [photo.photo_id, index]));
  const stories = value.stories.map((story, storyIndex) => {
    const at = `$.stories[${storyIndex}]`;
    keys(story, ['title', 'summary', 'image_prompt', 'panels'], at);
    if (!Array.isArray(story.panels) || story.panels.length !== 4) throw new StoryValidationError('invalid_panels', at + '.panels', { expected: 4, ...(Array.isArray(story.panels) ? { actual: story.panels.length } : {}) });
    const numbers = new Set<number>();
    const sources = new Set<string>();
    const panels = story.panels.map((panel, index) => {
      const panelAt = `${at}.panels[${index}]`;
      keys(panel, ['panel', 'description', 'source_photo_ids', 'image_prompt'], panelAt);
      if (typeof panel.panel !== 'number' || !Number.isInteger(panel.panel) || panel.panel < 1 || panel.panel > 4 || numbers.has(panel.panel)) throw new StoryValidationError('invalid_panel_order', panelAt + '.panel');
      numbers.add(panel.panel);
      const refs = panel.source_photo_ids;
      if (!Array.isArray(refs) || !refs.length) throw new StoryValidationError('invalid_story_sources', panelAt + '.source_photo_ids');
      if (new Set(refs).size !== refs.length) throw new StoryValidationError('duplicate_source_id', panelAt + '.source_photo_ids');
      const ids = refs.map(alias => {
        const id = typeof alias === 'string' ? byAlias.get(alias) : undefined;
        if (id === undefined) throw new StoryValidationError('unknown_source_id', panelAt + '.source_photo_ids');
        sources.add(id); return id;
      });
      return { ...panel, panel: panel.panel, source_photo_ids: ids };
    }).sort((a, b) => a.panel - b.panel);
    return { ...story, panels, source_photo_ids: [...sources].sort((a, b) => positions.get(a)! - positions.get(b)!) };
  }).sort((a, b) => positions.get(a.source_photo_ids[0])! - positions.get(b.source_photo_ids[0])!);
  // 全覆盖要求按版本决定；跨故事唯一归属、四格/文本和实际UUID校验始终执行。
  return validateResult({ ...value, stories }, count ?? stories.length, photos, profile.source_coverage !== 'representative_panels');
}

export function coverageOf(result: StoryResult, photos: PhotoSummary[]) {
  const referenced = new Set(result.stories.flatMap(story => story.source_photo_ids));
  const unreferenced = photos.filter(photo => !referenced.has(photo.photo_id)).map(photo => photo.photo_id);
  return { policy: 'representative_panels', input_photo_count: photos.length, referenced_photo_count: referenced.size,
    all_photos_referenced: unreferenced.length === 0, unreferenced_photo_ids: unreferenced };
}
