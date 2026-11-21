import { readBounded } from '../../worker-image2txt/src/bytes';
import type { StoryProfile } from './config';
import type { PhotoSummary, StoryAI } from './types';
import { HttpError } from './types';
import { validateResult } from './output';

export async function generate(ai: StoryAI, profile: StoryProfile, input: string, count: number, photos: PhotoSummary[]) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new HttpError(504, 'model_timeout')); controller.abort(); }, profile.provider_timeout_ms);
  });
  try {
    return await Promise.race([timeout, (async () => {
      // 单次原生 binding 调用；不使用 SDK/Gateway 自动重试，不传图片或对象键。
      const response = await ai.run(profile.model, {
        messages: [{ role: 'system', content: profile.system_prompt }, { role: 'user', content: input }],
        stream: false, max_completion_tokens: profile.max_completion_tokens,
        reasoning_effort: profile.reasoning_effort as 'low' | 'medium' | 'xhigh', temperature: profile.temperature,
        response_format: { type: 'json_schema', json_schema: { name: 'daily_comic_stories_v1', strict: true, schema: profile.response_schema } },
      }, { returnRawResponse: true, signal: controller.signal });
      if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new HttpError(502, 'model_response_error');
      }
      let data: any;
      try {
        const bytes = await readBounded(response.body, profile.max_response_bytes, controller.signal);
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch { throw new HttpError(502, 'invalid_model_response'); }
      const choice = data?.choices?.[0];
      if (!Array.isArray(data?.choices) || data.choices.length !== 1 || choice?.finish_reason !== 'stop'
        || choice.message?.role !== 'assistant' || choice.message?.refusal || typeof choice.message?.content !== 'string') {
        throw new HttpError(502, 'incomplete_model_response');
      }
      let result;
      try { result = validateResult(JSON.parse(choice.message.content), count, photos); }
      catch { throw new HttpError(502, 'invalid_story_result'); }
      const provider_request_id = typeof data.id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(data.id) ? data.id : null;
      const usage: Record<string, number> = {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        if (Number.isSafeInteger(data.usage?.[key]) && data.usage[key] >= 0) usage[key] = data.usage[key];
      }
      return { ...result, provider_request_id, usage };
    })()]);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'model_transport_error');
  } finally {
    clearTimeout(timer); controller.abort();
  }
}
