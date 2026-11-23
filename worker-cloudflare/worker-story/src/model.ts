import { readBounded } from '../../worker-image2txt/src/bytes';
import type { StoryProfile } from './config';
import type { PhotoSummary, StoryAI } from './types';
import { HttpError } from './types';
import { StoryValidationError } from './output';
import { decodeResult, responseSchema } from './references';
import { parseUsage, type Usage } from './accounting';
import { bindingFailure, responseFailure } from './provider-errors';

interface ModelContext { requestId?: string; storyVersion?: string }
export async function generate(ai: StoryAI, profile: StoryProfile, input: string, count: number | null, photos: PhotoSummary[], context: ModelContext = {}) {
  const controller = new AbortController();
  const began = Date.now();
  let stage = 'waiting_headers';
  let usage: Usage = {};
  let responseBytes = 0;
  let bodyMs: number | null = null;
  let providerRequestId: string | null = null;
  let headersMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const log = (event: string, extra: Record<string, unknown> = {}) => console.info(JSON.stringify({
    event: 'story_model', stage: event, request_id: context.requestId ?? null, story_version: context.storyVersion ?? null,
    model: profile.model, wall_ms: Date.now() - began, ...extra,
  }));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new HttpError(504, 'model_timeout')); controller.abort(); }, profile.provider_timeout_ms);
  });
  log('started', { thinking_enabled: profile.enable_thinking ?? true, max_completion_tokens: profile.max_completion_tokens,
    story_count: count, story_count_mode: count === null ? 'auto' : 'fixed', input_bytes: new TextEncoder().encode(input).byteLength, timeout_ms: profile.provider_timeout_ms });
  try {
    return await Promise.race([timeout, (async () => {
      // v1 不发送该字段，保留已锁定历史语义；v2 显式关闭默认开启的 thinking。
      const response = await ai.run(profile.model, {
        messages: [{ role: 'system', content: profile.system_prompt }, { role: 'user', content: input }],
        stream: false, max_completion_tokens: profile.max_completion_tokens,
        // Gemma 不接受 Qwen 的 reasoning_effort；其余字段使用已核对的 Chat Completions 协议。
        ...(profile.reasoning_effort === undefined ? {} : { reasoning_effort: profile.reasoning_effort as 'low' | 'medium' | 'xhigh' }),
        temperature: profile.temperature,
        ...(profile.enable_thinking === undefined ? {} : { chat_template_kwargs: { enable_thinking: profile.enable_thinking } }),
        response_format: { type: 'json_schema', json_schema: { name: profile.source_reference_mode === 'panel_aliases' ? 'daily_comic_stories_panel_aliases_v1' : 'daily_comic_stories_v1', strict: true, schema: responseSchema(profile, count, photos) } },
      }, { returnRawResponse: true, signal: controller.signal });
      headersMs = Date.now() - began;
      stage = 'reading_body';
      log('headers_received', { provider_http_status: response.status, headers_ms: headersMs });
      if (!response.ok) {
        const failure = await responseFailure(response, controller.signal);
        usage = (failure.details.usage as Usage | undefined) ?? {};
        throw failure;
      }
      if (!response.body) throw new HttpError(502, 'model_response_error', { provider_http_status: response.status });
      let data: any;
      try {
        const bytes = await readBounded(response.body, profile.max_response_bytes, controller.signal);
        responseBytes = bytes.byteLength;
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      } catch { throw new HttpError(502, 'invalid_model_response'); }
      bodyMs = Date.now() - began - headersMs;
      stage = 'validating_output';
      log('body_received', { response_bytes: responseBytes, body_ms: bodyMs });
      usage = parseUsage(data?.usage);
      providerRequestId = typeof data?.id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(data.id) ? data.id : null;
      const choice = data?.choices?.[0];
      if (!Array.isArray(data?.choices) || data.choices.length !== 1 || choice?.finish_reason !== 'stop'
        || choice.message?.role !== 'assistant' || choice.message?.refusal || typeof choice.message?.content !== 'string') {
        throw new HttpError(502, 'incomplete_model_response');
      }
      const provider_request_id = providerRequestId;
      let result;
      try { result = decodeResult(JSON.parse(choice.message.content), count, photos, profile); }
      catch (error) {
        const validation = error instanceof StoryValidationError
          ? { validation_code: error.code, validation_path: error.field, ...error.counts }
          : { validation_code: error instanceof SyntaxError ? 'invalid_story_json' : 'unknown_validation_error', validation_path: '$' };
        throw new HttpError(502, 'invalid_story_result', { ...validation, provider_request_id, usage });
      }
      const model_timings = { headers_ms: headersMs, body_ms: bodyMs, total_ms: Date.now() - began, response_bytes: responseBytes };
      log('succeeded', { provider_request_id, ...model_timings, usage });
      return { ...result, provider_request_id, usage, model_timings };
    })()]);
  } catch (error) {
    const failure = error instanceof HttpError ? error : bindingFailure(error) ?? new HttpError(502, 'model_transport_error');
    const details = { ...failure.details, usage, provider_request_id: providerRequestId,
      model_timings: { headers_ms: headersMs, body_ms: bodyMs, total_ms: Date.now() - began, response_bytes: responseBytes },
      model_stage: stage, model_elapsed_ms: Date.now() - began, headers_ms: headersMs };
    log('failed', { code: failure.code, ...details });
    throw new HttpError(failure.status, failure.code, details);
  } finally {
    clearTimeout(timer); controller.abort();
  }
}
