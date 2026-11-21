import source from '../config/analysis-profiles.json';
import lock from '../config/analysis-profiles.lock.json';

export interface AnalysisProfile {
  readonly adapter: 'workers-ai-chat';
  readonly model: string;
  readonly prompt: string;
  readonly max_completion_tokens: number;
  readonly enable_thinking: boolean;
}
export class AnalysisConfigError extends Error {
  constructor(readonly code: string) { super(code); }
}
const versionPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const fields = ['adapter', 'enable_thinking', 'max_completion_tokens', 'model', 'prompt'];
const record = (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
if (Object.keys(source).sort().join(',') !== '$schema,default_version,profiles,schema_version'
  || source.$schema !== './analysis-profiles.schema.json' || !record(source.profiles)
  || Object.keys(source.profiles).length < 1 || Object.keys(source.profiles).length > 100
  || Object.keys(lock).sort().join(',') !== 'profiles,retired_versions,schema_version'
  || !record(lock.profiles) || !Array.isArray(lock.retired_versions)
  || lock.retired_versions.some(v => typeof v !== 'string' || !versionPattern.test(v))
  || Object.values(lock.profiles).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
  throw new AnalysisConfigError('invalid_analysis_catalog');
}
const profiles: Readonly<Record<string, AnalysisProfile>> = Object.freeze(Object.fromEntries(
  Object.entries(source.profiles).map(([version, value]) => {
    if (!versionPattern.test(version) || lock.retired_versions.includes(version) || Object.keys(value).sort().join(',') !== fields.join(',')
      || value.adapter !== 'workers-ai-chat' || !/^@cf\/[a-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.model)
      || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 16000
      || !Number.isInteger(value.max_completion_tokens) || value.max_completion_tokens < 1 || value.max_completion_tokens > 4096
      || typeof value.enable_thinking !== 'boolean') throw new AnalysisConfigError('invalid_analysis_profile');
    return [version, Object.freeze({ ...value, adapter: 'workers-ai-chat' as const })];
  }),
));
export const DEFAULT_ANALYSIS_VERSION: string = source.default_version;
if (source.schema_version !== 1 || lock.schema_version !== 1 || !Object.hasOwn(profiles, DEFAULT_ANALYSIS_VERSION)) {
  throw new AnalysisConfigError('invalid_analysis_catalog');
}
export const DEFAULT_ANALYSIS_PROFILE = profiles[DEFAULT_ANALYSIS_VERSION];
export const ANALYSIS_VERSIONS = Object.freeze(Object.keys(profiles));
export const isAnalysisVersion = (version: unknown): version is string => typeof version === 'string' && Object.hasOwn(profiles, version);

export function canonicalProfile(profile: AnalysisProfile): string {
  return JSON.stringify(Object.fromEntries(Object.keys(profile).sort().map(key => [key, profile[key as keyof AnalysisProfile]])));
}
export async function profileFingerprints(): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(profiles).map(async ([version, profile]) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalProfile(profile)));
    return [version, Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')];
  }));
  return Object.fromEntries(entries);
}
// 首次请求中懒校验；不能在 Workers 全局初始化期间调用 WebCrypto。
let verified: Promise<void> | undefined;
export async function validateAnalysisConfig(): Promise<void> {
  const actual = await profileFingerprints();
  const expected: Record<string, string> = lock.profiles;
  if (Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',')
    || Object.entries(actual).some(([version, hash]) => expected[version] !== hash)) {
    throw new AnalysisConfigError('analysis_profile_lock_mismatch');
  }
}
export async function getAnalysisProfile(version: string): Promise<AnalysisProfile> {
  verified ??= validateAnalysisConfig();
  await verified;
  if (!isAnalysisVersion(version)) throw new AnalysisConfigError('unsupported_analysis_version');
  return profiles[version];
}
