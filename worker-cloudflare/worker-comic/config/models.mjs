export const specs = Object.freeze({
  '@cf/black-forest-labs/flux-2-klein-9b': Object.freeze({ adapter: 'workers-ai', referenceSide: 500, steps: 4 }),
  '@cf/black-forest-labs/flux-2-klein-4b': Object.freeze({ adapter: 'workers-ai', referenceSide: 500, steps: 4 }),
  'openai/gpt-image-2.6-flare': Object.freeze({ adapter: 'workers-ai-flare', referenceSide: 1024, quality: 'medium', output_format: 'png' }),
});
export const models = Object.freeze(Object.keys(specs));
export const defaultModel = '@cf/black-forest-labs/flux-2-klein-9b';
export const profileVersion = 'comic-v1';
export const flareProfileVersion = 'comic-v2-flare-binding';
export const width = 1024;
export const height = 1536;
export const modelTimeoutMs = 180_000;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** @param {unknown} model */
export const isModel = model => typeof model === 'string' && models.includes(model);
