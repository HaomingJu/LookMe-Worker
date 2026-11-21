import catalog from '../config/story-profiles.json';
import lock from '../config/story-profiles.lock.json';
import { getAnalysisProfile, isAnalysisVersion } from '../../shared/analysis-config';

export type StoryProfile = typeof catalog.profiles.v1;
export const DEFAULT_VERSION: string = catalog.default_version;
const versions: Record<string, StoryProfile> = catalog.profiles;
const fields = ['adapter', 'analysis_version', 'date_basis', 'default_story_count', 'max_completion_tokens', 'max_input_bytes', 'max_photos', 'max_response_bytes', 'max_stories', 'model', 'output_revision', 'provider_timeout_ms', 'reasoning_effort', 'response_schema', 'system_prompt', 'temperature', 'timezone'];
const inRange = (x: number, min: number, max: number) => Number.isInteger(x) && x >= min && x <= max;
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
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(version) || Object.keys(p).sort().join(',') !== fields.join(',')
      || p.adapter !== 'workers-ai-chat' || p.model !== '@cf/qwen/qwen3.8-27b'
      || p.timezone !== 'Asia/Shanghai' || p.date_basis !== 'uploaded_at_ms' || p.output_revision !== 1
      || !isAnalysisVersion(p.analysis_version) || typeof p.system_prompt !== 'string' || !p.system_prompt.trim() || p.system_prompt.length > 16000
      || !inRange(p.max_stories, 1, 8) || !inRange(p.default_story_count, 1, p.max_stories)
      || !inRange(p.max_photos, p.max_stories, 256) || !inRange(p.max_input_bytes, 1024, 65536)
      || !inRange(p.max_response_bytes, 1024, 262144) || !inRange(p.provider_timeout_ms, 1000, 90000)
      || !inRange(p.max_completion_tokens, 1, 16384) || !['low', 'medium', 'xhigh'].includes(p.reasoning_effort)
      || !Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2
      || p.response_schema?.type !== 'object' || p.response_schema.additionalProperties !== false) throw new Error('invalid_story_profile');
    await getAnalysisProfile(p.analysis_version);
    result[version] = await sha256(canonical(p));
  }
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
export const hasVersion = (v: string) => Object.hasOwn(versions, v);
