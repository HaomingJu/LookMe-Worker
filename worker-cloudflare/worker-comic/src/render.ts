import { width, height, modelTimeoutMs, specs } from '../config/models.mjs';
import { imageDataUrl, readBounded } from '../../worker-image2txt/src/bytes';
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
  return rasterBytes(Uint8Array.from(text, c => c.charCodeAt(0)));
}

function rasterBytes(bytes: Uint8Array<ArrayBuffer>): Raster {
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

// Accept inline raster data or Cloudflare's image service / R2 object endpoints.
async function downloadFlareImage(value: unknown, outbound: typeof fetch, signal: AbortSignal) {
  if (typeof value !== 'string') throw new ComicError(502, 'invalid_model_asset_url', 'non-string');
  if (/^(?:data:image\/(?:png|jpeg);base64,)?(?:iVBORw0KGgo|\/9j\/)/.test(value)) {
    const raster = rasterOf(value);
    if (value.startsWith('data:') && !value.startsWith(`data:${raster.mime};`)) throw new ComicError(502, 'invalid_model_image');
    return raster;
  }
  if (value.length > 8192 || !/^https:\/\//i.test(value)) throw new ComicError(502, 'invalid_model_asset_url', 'not-https');
  let url: URL;
  try { url = new URL(value); } catch { throw new ComicError(502, 'invalid_model_asset_url', 'malformed'); }
  const imageService = /^[a-z0-9-]+\.aig\.cloudflare\.com$/.test(url.hostname);
  const publicR2 = /^pub-[a-f0-9]{32}\.r2\.dev$/.test(url.hostname);
  // Observed on a real Unified Billing Flare result; R2 uses the bucket as
  // the first host label. Do not allow arbitrary S3 accounts or bucket hosts.
  const gatewayR2 = url.hostname === 'ai-gateway-outputs.0d37909e38d3e99c29fa2cd343ac421a.r2.cloudflarestorage.com';
  const origin = /^(?:[a-z0-9-]+\.){1,5}(?:cloudflare\.com|cloudflarestorage\.com|r2\.dev)$/.test(url.hostname)
    && url.hostname.length <= 120 ? url.hostname : 'other-https';
  if (url.protocol !== 'https:' || !(imageService || publicR2 || gatewayR2) ||
    url.username || url.password || url.port || url.hash || url.pathname === '/') {
    throw new ComicError(502, 'invalid_model_asset_url', origin);
  }
  let response: Response;
  try {
    response = await outbound(url.href, { method: 'GET', redirect: 'manual', signal,
      headers: { Accept: 'image/png, image/jpeg', 'Cache-Control': 'no-store' },
      cf: { cacheTtl: 0 } });
  } catch { signal.throwIfAborted(); throw new ComicError(502, 'model_asset_download_failed'); }
  const type = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || (type !== 'image/png' && type !== 'image/jpeg' && type !== 'application/octet-stream') ||
    Number(response.headers.get('Content-Length')) > maxOutput) {
    if (response.body) void response.body.cancel().catch(() => {});
    throw new ComicError(502, 'model_asset_download_failed');
  }
  let bytes: Uint8Array;
  try { bytes = await readBounded(response.body, maxOutput, signal); }
  catch { signal.throwIfAborted(); throw new ComicError(502, 'model_asset_download_failed'); }
  const raster = rasterBytes(new Uint8Array(bytes));
  if (type !== 'application/octet-stream' && raster.mime !== type) throw new ComicError(502, 'invalid_model_image');
  return raster;
}

export function checkProvider(env: Env, model: Model) {
  if (specs[model].adapter === 'workers-ai-flare' && env.COMIC_FLARE_ENABLED !== true) {
    throw new ComicError(503, 'flare_disabled');
  }
  if (!env.AI) throw new ComicError(503, 'workers_ai_unavailable');
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
  return {
    async submit(signal) {
      const images = [];
      for (const ref of refs) images.push(imageDataUrl(new Uint8Array(await ref.blob.arrayBuffer())));
      signal.throwIfAborted();
      return env.AI!.run(model, { prompt, images, size, quality: profile.quality, output_format: profile.output_format });
    },
    async read(input, signal) {
      const raw = input instanceof Response ? await boundedJson(input, signal) : input;
      const payload = object(raw), result = object(payload.result);
      if (payload.state !== 'Completed') throw new ComicError(502, 'invalid_model_response');
      return { raster: await downloadFlareImage(result.image, outbound, signal), providerId: providerId(payload.id) };
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
