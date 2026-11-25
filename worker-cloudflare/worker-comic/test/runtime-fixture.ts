import { createWorker } from '../src/index';
import type { Env } from '../src/common';
import { comicPng } from './fixtures';

async function checkReference(file: FormDataEntryValue | null) {
  if (!(file instanceof File) || file.type !== 'image/jpeg') throw Error('missing JPEG reference');
  if (await file.text().then(text => text.includes('SYNTHETIC_PRIVATE_LOCATION'))) throw Error('private metadata was forwarded');
}

export default {
  fetch(request: Request, bound: Env) {
    const failure = request.headers.get('x-fixture-error');
    const assetUrl = 'https://examples.aig.cloudflare.com/mock/asset.png?signature=synthetic';
    const publicR2 = 'https://pub-0123456789abcdef0123456789abcdef.r2.dev/mock.png';
    const signedR2 = 'https://ai-gateway-outputs.0d37909e38d3e99c29fa2cd343ac421a.r2.cloudflarestorage.com/mock/file?X-Amz-Signature=' + 'a'.repeat(64);
    const worker = createWorker({ timeout: failure === 'timeout' ? 30 : undefined, outbound: (async (url, init) => {
      if (![assetUrl, publicR2, signedR2].includes(String(url)) || init?.redirect !== 'manual' || init.method !== 'GET' ||
        new Headers(init.headers).has('authorization') || new Headers(init.headers).has('cookie')) {
        throw Error('unexpected asset request');
      }
      if (failure === 'flare-redirect') return new Response(null, { status: 302, headers: { Location: 'https://example.invalid' } });
      if (failure === 'flare-oversize') return new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': '9000000' } });
      if (failure === 'flare-corrupt') return new Response('not an image', { headers: { 'Content-Type': 'image/png' } });
      const bytes = Uint8Array.from(atob(comicPng), c => c.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) } });
    }) as typeof fetch });
    const AI: NonNullable<Env['AI']> = {
      async run(model, options) {
        if (model === 'openai/gpt-image-2.6-flare') {
          const { prompt, size, quality, output_format, images } = options as
            { prompt: string; size: string; quality: string; output_format: string; images: string[] };
          if (size !== '1024x1536' || quality !== 'medium' || output_format !== 'png' ||
            !prompt.includes('Exactly four') || !Array.isArray(images) || images.length < 1 || images.length > 3) {
            throw Error('unexpected Flare binding input');
          }
          for (const image of images) {
            if (!image.startsWith('data:image/jpeg;base64,') ||
              atob(image.split(',')[1]).includes('SYNTHETIC_PRIVATE_LOCATION')) throw Error('invalid reference');
          }
          const target = failure === 'flare-external' ? 'https://examples.aig.cloudflare.com.evil.invalid/mock.png' :
            failure === 'flare-credential-url' ? 'https://user:password@examples.aig.cloudflare.com/mock.png' :
            failure === 'flare-result-incomplete' ? null :
            failure === 'flare-r2' ? publicR2 :
            failure === 'flare-r2-signed' ? signedR2 :
            failure === 'flare-r2-other-bucket' ? signedR2.replace('ai-gateway-outputs.', 'unrecognized-bucket.') :
            failure === 'flare-inline' ? 'data:image/png;base64,'+comicPng : assetUrl;
          return { state: target ? 'Completed' : 'Failed', id: 'mock-flare', result: { image: target } };
        }
        const { multipart } = options as { multipart: { body: ReadableStream; contentType: string } };
        const form = await new Response(multipart.body, { headers: { 'Content-Type': multipart.contentType } }).formData();
        if (!model.startsWith('@cf/') || form.get('width') !== '1024' || form.get('height') !== '1536' ||
          !(form.get('input_image_0') instanceof File) || form.has('steps')) throw Error('bad multipart');
        for (const [key, file] of form.entries()) if (key.startsWith('input_image_')) await checkReference(file);
        if (failure === 'timeout') return new Promise(() => {});
        if (failure === 'invalid') return { image: 'https://outside.invalid/private' };
        return { id: 'mock-klein', image: comicPng };
      },
    };
    const IMAGES = { input(stream: ReadableStream) {
      return { transform(options: { width: number; height: number; fit: string }) {
        if (![500, 1024].includes(options.width) || options.width !== options.height || options.fit !== 'scale-down') throw Error('expected bounded scale-down');
        return { async output() { return { response: () => new Response(stream, { headers: { 'Content-Type': 'image/jpeg' } }) }; } };
      } };
    } } as unknown as Env['IMAGES'];
    return worker.fetch(request, {
      ...bound, AI, IMAGES, COMIC_GENERATION_ENABLED: failure !== 'disabled',
      COMIC_ALLOW_ALL_AUTHENTICATED_USERS: failure === 'allow-all-dev',
      COMIC_GENERATOR_OWNER_IDS: 'owner-a,owner-b', COMIC_FLARE_ENABLED: failure !== 'flare-disabled',
      ...(failure === 'storage' ? { COMICS: { put: async () => { throw Error('mock write failure'); } } as unknown as R2Bucket } : {}),
    });
  },
};
