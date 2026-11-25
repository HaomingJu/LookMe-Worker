import { width, height, modelTimeoutMs, specs } from '../config/models.mjs';
import { readBounded } from '../../worker-image2txt/src/bytes';
import { ComicError, sha256, type Env } from './common';

export type Model = keyof typeof specs;
export const maxOutput = 8 * 1024 * 1024;
const maxProviderBody = Math.ceil(maxOutput * 4 / 3) + 65_536;
const maxRef = 2 * 1024 * 1024;
const size = `${width}x${height}`;
export type Photo = { photo_id: string; object_key: string; sha256: string; byte_size: number; width: number; height: number };
export type Ref = { photo_id: string; source_sha256: string; input_sha256: string; blob: Blob };
export type Raster = { bytes: Uint8Array<ArrayBuffer>; mime: 'image/png' | 'image/jpeg'; width: number; height: number };
type Prepared = { submit: (signal: AbortSignal) => Promise<unknown>; read: (raw: unknown, signal: AbortSignal) => Promise<{ raster: Raster; providerId: string | null }> };

function jpegDimensions(bytes: Uint8Array) {
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 2; i + 4 < bytes.length;) {
    if (bytes[i++] !== 255) return;
    while (bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (i + 2 > bytes.length || marker === 0 || marker === 218 || marker === 217) return;
    const length = view.getUint16(i);
    if (length < 2 || i + length > bytes.length) return;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) {
      return { width: view.getUint16(i + 5), height: view.getUint16(i + 3) };
    }
    i += length;
  }
}

// Keep JPEG coding segments and scan data, not APP metadata (EXIF/GPS, XMP,
// thumbnails) or comments. Preserve the standard Adobe color-transform marker.
function stripJpegMetadata(bytes: Uint8Array) {
  const segments: Uint8Array[] = [bytes.subarray(0, 2)];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 2; i + 4 < bytes.length;) {
    const start = i;
    if (bytes[i++] !== 255) break;
    while (bytes[i] === 255) i++;
    const marker = bytes[i++];
    if (i + 2 > bytes.length) break;
    const length = view.getUint16(i);
    if (length < 2 || i + length > bytes.length) break;
    if (marker === 218) {
      segments.push(bytes.subarray(start));
      const cleaned = new Uint8Array(segments.reduce((size, part) => size + part.length, 0));
      let offset = 0;
      for (const part of segments) { cleaned.set(part, offset); offset += part.length; }
      return cleaned;
    }
    const adobe = marker === 238 && length === 14 &&
      [65,100,111,98,101].every((value, index) => bytes[i + 2 + index] === value);
    if (adobe || (marker !== 254 && (marker < 224 || marker > 239))) {
      segments.push(bytes.subarray(start, i + length));
    }
    i += length;
  }
  throw new ComicError(503, 'reference_transform_invalid');
}

export async function reference(env: Env, photo: Photo, side: number): Promise<Ref> {
  if (!env.IMAGES) throw new ComicError(503, 'reference_transform_unavailable');
  const object = await env.PHOTOS.get(photo.object_key);
  if (!object || object.size !== photo.byte_size || object.size < 1 || object.size > maxRef) {
    throw new ComicError(409, 'reference_unavailable');
  }
  const raw = await readBounded(object.body, maxRef, AbortSignal.timeout(15_000));
  if (raw.byteLength !== photo.byte_size || await sha256(raw) !== photo.sha256) {
    throw new ComicError(409, 'reference_integrity_mismatch');
  }
  const dimensions = jpegDimensions(raw);
  if (!dimensions || dimensions.width !== photo.width || dimensions.height !== photo.height) {
    throw new ComicError(409, 'reference_dimensions_mismatch');
  }
  const input = new Blob([new Uint8Array(raw)], { type: 'image/jpeg' });
  const transformed = (await env.IMAGES.input(input.stream()).transform({
    width: side, height: side, fit: 'scale-down',
  }).output({ format: 'image/jpeg', quality: 85 })).response();
  if (!transformed.ok || !transformed.body) throw new ComicError(503, 'reference_transform_failed');
  const data = await readBounded(transformed.body, maxRef, AbortSignal.timeout(15_000));
  const fitted = jpegDimensions(data);
  if (!fitted || fitted.width < 1 || fitted.height < 1 || fitted.width > side || fitted.height > side) {
    throw new ComicError(503, 'reference_transform_invalid');
  }
  const cleaned = stripJpegMetadata(data);
  return { photo_id: photo.photo_id, source_sha256: photo.sha256, input_sha256: await sha256(cleaned),
    blob: new Blob([cleaned], { type: 'image/jpeg' }) };
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const providerId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id) ? id : null;

function rasterOf(value: unknown): Raster {
  if (typeof value !== 'string') throw new ComicError(502, 'invalid_model_image');
  const base = value.replace(/^data:image\/(?:png|jpeg);base64,/, '');
  if (!base || base.length > Math.ceil(maxOutput / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base)) {
    throw new ComicError(502, 'invalid_model_image');
  }
  let text: string;
  try { text = atob(base); } catch { throw new ComicError(502, 'invalid_model_image'); }
  if (text.length > maxOutput) throw new ComicError(502, 'invalid_model_image');
  const bytes = Uint8Array.from(text, c => c.charCodeAt(0));
  if (bytes.length >= 45 && [137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]
    .every((value, index) => bytes[index] === value) &&
    [0,0,0,0,73,69,78,68,174,66,96,130].every((value, index) => bytes[bytes.length - 12 + index] === value)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dimensions = { width: view.getUint32(16), height: view.getUint32(20) };
    if (dimensions.width === width && dimensions.height === height) return { bytes, mime: 'image/png', ...dimensions };
  }
  const dimensions = jpegDimensions(bytes);
  if (dimensions?.width === width && dimensions.height === height) return { bytes, mime: 'image/jpeg', ...dimensions };
  throw new ComicError(502, 'invalid_model_image');
}

async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw new ComicError(response.status === 504 ? 504 : 502, 'model_request_failed');
  }
  try { return JSON.parse(new TextDecoder().decode(await readBounded(response.body, maxProviderBody, signal))) as unknown; }
  catch { signal.throwIfAborted(); throw new ComicError(502, 'invalid_model_response'); }
}

export function checkProvider(env: Env, model: Model) {
  if (specs[model].adapter === 'workers-ai') {
    if (!env.AI) throw new ComicError(503, 'workers_ai_unavailable');
  } else if (env.COMIC_FLARE_ENABLED !== true || !/^[0-9a-f]{32}$/.test(env.COMIC_GATEWAY_ACCOUNT_ID ?? '') ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(env.COMIC_GATEWAY_ID ?? '') || !env.CF_AIG_TOKEN?.trim()) {
    throw new ComicError(503, 'flare_gateway_unavailable');
  }
}

export function prepareRender(env: Env, model: Model, prompt: string, refs: Ref[], outbound: typeof fetch): Prepared {
  const form = new FormData();
  form.append('prompt', prompt);
  if (specs[model].adapter === 'workers-ai') {
    form.append('width', String(width));
    form.append('height', String(height));
    // Klein models have a fixed 4-step schedule; do not pass a steps override.
    refs.forEach((ref, i) => form.append(`input_image_${i}`, ref.blob, `ref-${i}.jpg`));
    const encoded = new Response(form);
    return {
      submit: () => env.AI!.run(model, { multipart: { body: encoded.body, contentType: encoded.headers.get('Content-Type') } }),
      async read(input, signal) {
        const raw = input instanceof Response ? await boundedJson(input, signal) : input;
        const payload = object(raw);
        return { raster: rasterOf(payload.image ?? object(payload.result).image), providerId: providerId(payload.id) };
      },
    };
  }
  const profile = specs['openai/gpt-image-2.6-flare'];
  form.append('model', 'gpt-image-2.6-flare');
  form.append('size', size);
  form.append('quality', profile.quality);
  form.append('output_format', profile.output_format);
  refs.forEach((ref, i) => form.append('image[]', ref.blob, `ref-${i}.jpg`));
  const endpoint = `https://gateway.ai.cloudflare.com/v1/${env.COMIC_GATEWAY_ACCOUNT_ID}/${env.COMIC_GATEWAY_ID}/openai/images/edits`;
  return {
    submit: signal => outbound(endpoint, { method: 'POST', body: form, signal, redirect: 'error',
      headers: { 'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`, 'cf-aig-collect-log': 'false',
        'cf-aig-collect-log-payload': 'false', 'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
        'cf-aig-request-timeout': String(modelTimeoutMs) } }),
    async read(raw, signal) {
      if (!(raw instanceof Response)) throw new ComicError(502, 'invalid_model_response');
      const payload = object(await boundedJson(raw, signal));
      const first = Array.isArray(payload.data) && payload.data.length === 1 ? object(payload.data[0]) : {};
      // A provider-native result is inline b64_json. Never fetch a URL supplied in model output.
      return { raster: rasterOf(first.b64_json), providerId: providerId(raw.headers.get('x-request-id') ?? raw.headers.get('cf-aig-request-id')) };
    },
  };
}

export async function render(prepared: Prepared, timeout = modelTimeoutMs) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new ComicError(504, 'model_timeout')); controller.abort(); }, timeout);
      }),
      prepared.submit(controller.signal).then(result => prepared.read(result, controller.signal)),
    ]);
  } catch (error) {
    if (error instanceof ComicError) throw error;
    throw new ComicError(502, 'model_request_failed');
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
