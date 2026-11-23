// CLI 与 Worker 共用同一模型/版本选择规则；不能用请求参数覆盖已锁定模型。
export class SelectionError extends Error {
  /** @param {string} code */
  constructor(code) { super(code); this.code = code; }
}
/**
 * @template {{model: string}} T
 * @param {{default_version: string, profiles: Record<string, T>, model_defaults: Record<string, string>}} catalog
 * @param {{model?: unknown, story_version?: unknown}} [request]
 * @returns {{version: string, profile: T}}
 */
export function selectProfile(catalog, request = {}) {
  const { model, story_version: version } = request;
  if (model !== undefined && (typeof model !== 'string' || !Object.hasOwn(catalog.model_defaults, model))) {
    throw new SelectionError('unsupported_model');
  }
  if (version !== undefined && (typeof version !== 'string' || !Object.hasOwn(catalog.profiles, version))) {
    throw new SelectionError('invalid_story_version');
  }
  const selected = /** @type {string} */ (version ?? (model === undefined ? catalog.default_version : catalog.model_defaults[/** @type {string} */ (model)]));
  if (!Object.hasOwn(catalog.profiles, selected)) throw new Error('invalid_model_defaults');
  const profile = catalog.profiles[selected];
  if (model !== undefined && model !== profile.model) throw new SelectionError('model_version_mismatch');
  return { version: selected, profile };
}
