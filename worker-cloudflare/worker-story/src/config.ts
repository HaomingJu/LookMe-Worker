import catalog from '../config/story-profiles.json';
import lock from '../config/story-profiles.lock.json';
import { selectProfile } from '../config/selection.mjs';
import { getAnalysisProfile, isAnalysisVersion } from '../../shared/analysis-config';
import { validateReferenceSchema } from './references';

export type StoryProfile = Omit<typeof catalog.profiles.v1, 'response_schema' | 'default_story_count' | 'reasoning_effort'> & {
  response_schema: Record<string, unknown>; enable_thinking?: boolean; source_reference_mode?: string; source_coverage?: string;
  default_story_count?: number; reasoning_effort?: string; story_count_mode?: string;
};
export const DEFAULT_VERSION: string = catalog.default_version;
const versions: Record<string, StoryProfile> = catalog.profiles;
const MODELS = ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it'];
const fields = ['adapter', 'analysis_version', 'date_basis', 'max_completion_tokens', 'max_input_bytes', 'max_photos', 'max_response_bytes', 'max_stories', 'model', 'output_revision', 'provider_timeout_ms', 'response_schema', 'system_prompt', 'temperature', 'timezone'];
const optional = ['default_story_count', 'reasoning_effort', 'enable_thinking', 'source_reference_mode', 'source_coverage', 'story_count_mode'];
const inRange = (x: unknown, min: number, max: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max;
// 递归规范化，配置属性顺序改变不影响指纹；语义变化必须新建版本。
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function fingerprints(): Promise<Record<string, string>> {
  if (catalog.schema_version !== 1 || !Object.hasOwn(versions, DEFAULT_VERSION) || !Object.keys(versions).length) throw new Error('invalid_story_catalog');
  const result: Record<string, string> = {};
  for (const [version, p] of Object.entries(versions)) {
    const expectedFields = [...fields, ...optional.filter(key => Object.hasOwn(p, key))].sort();
    const auto = p.story_count_mode === 'auto';
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(version) || Object.keys(p).sort().join(',') !== expectedFields.join(',')
      || (Object.hasOwn(p, 'enable_thinking') && typeof p.enable_thinking !== 'boolean')
      || (Object.hasOwn(p, 'source_reference_mode') && p.source_reference_mode !== 'panel_aliases')
      || (Object.hasOwn(p, 'source_coverage') && (p.source_coverage !== 'representative_panels' || p.source_reference_mode !== 'panel_aliases'))
      || (Object.hasOwn(p, 'story_count_mode') && !auto)
      || (auto ? Object.hasOwn(p, 'default_story_count') || p.source_reference_mode !== 'panel_aliases' : !inRange(p.default_story_count, 1, p.max_stories))
      || p.adapter !== 'workers-ai-chat' || !MODELS.includes(p.model)
      || (p.model === MODELS[0] ? !['low', 'medium', 'xhigh'].includes(p.reasoning_effort ?? '') : Object.hasOwn(p, 'reasoning_effort'))
      || p.timezone !== 'Asia/Shanghai' || p.date_basis !== 'uploaded_at_ms' || p.output_revision !== 1
      || !isAnalysisVersion(p.analysis_version) || typeof p.system_prompt !== 'string' || !p.system_prompt.trim() || p.system_prompt.length > 16000
      || !inRange(p.max_stories, 1, 8) || !inRange(p.max_photos, p.max_stories, 256) || !inRange(p.max_input_bytes, 1024, 65536)
      || !inRange(p.max_response_bytes, 1024, 262144) || !inRange(p.provider_timeout_ms, 1000, 180000)
      || !inRange(p.max_completion_tokens, 1, 16384)
      || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2
      || p.response_schema?.type !== 'object' || p.response_schema.additionalProperties !== false) throw new Error('invalid_story_profile');
    validateReferenceSchema(p);
    await getAnalysisProfile(p.analysis_version);
    result[version] = await sha256(canonical(p));
  }
  // 模型只选择已锁定版本，不允许任意覆盖某个历史版本的model或参数。
  const defaults: Record<string, string> = catalog.model_defaults;
  if (!defaults || !Object.keys(defaults).length || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('invalid_model_defaults');
  for (const [model, version] of Object.entries(defaults)) {
    if (!MODELS.includes(model) || typeof version !== 'string' || !Object.hasOwn(versions, version)
      || versions[version].model !== model || versions[version].story_count_mode !== 'auto') throw new Error('invalid_model_defaults');
  }
  if (defaults[versions[DEFAULT_VERSION].model] !== DEFAULT_VERSION) throw new Error('invalid_default_story_version');
  return result;
}
export async function validateConfig(): Promise<void> {
  const actual = await fingerprints();
  if (lock.schema_version !== 1 || canonical(actual) !== canonical(lock.profiles)) throw new Error('story_profile_lock_mismatch');
}
let verified: Promise<void> | undefined;
export async function getProfile(version: string): Promise<StoryProfile> {
  verified ??= validateConfig();
  await verified;
  if (!Object.hasOwn(versions, version)) throw new Error('unsupported_story_version');
  return versions[version];
}
export async function resolveProfile(request: { model?: unknown; story_version?: unknown }) {
  verified ??= validateConfig();
  await verified;
  return selectProfile({ ...catalog, profiles: versions }, request);
}
export const hasVersion = (v: string) => Object.hasOwn(versions, v);
