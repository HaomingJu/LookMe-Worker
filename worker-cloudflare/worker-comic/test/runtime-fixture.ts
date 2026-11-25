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
    const worker = createWorker({ timeout: failure === 'timeout' ? 30 : undefined, outbound: (async (url, init) => {
      if (url !== 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/mock-gateway/openai/images/edits' ||
        init?.redirect !== 'error' || init.method !== 'POST') throw Error('unexpected endpoint');
      const headers = new Headers(init.headers);
      if (headers.get('cf-aig-authorization') !== 'Bearer synthetic-gateway-test-key' ||
        headers.get('cf-aig-collect-log') !== 'false' || headers.get('cf-aig-collect-log-payload') !== 'false' ||
        headers.get('cf-aig-skip-cache') !== 'true' || headers.get('cf-aig-max-attempts') !== '1') throw Error('unexpected headers');
      const form = init.body as FormData;
      if (form.get('model') !== 'gpt-image-2.6-flare' || form.get('size') !== '1024x1536' ||
        form.get('quality') !== 'medium' || form.getAll('image[]').length < 1 ||
        !String(form.get('prompt')).includes('Exactly four')) throw Error('unexpected openai input');
      for (const file of form.getAll('image[]')) await checkReference(file);
      return Response.json({ data: [{ b64_json: comicPng }] }, { headers: { 'x-request-id': 'mock-flare' } });
    }) as typeof fetch });
    const AI: NonNullable<Env['AI']> = {
      async run(model, options) {
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
      COMIC_GATEWAY_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', COMIC_GATEWAY_ID: 'mock-gateway',
      CF_AIG_TOKEN: 'synthetic-gateway-test-key',
      ...(failure === 'storage' ? { COMICS: { put: async () => { throw Error('mock write failure'); } } as unknown as R2Bucket } : {}),
    });
  },
};
