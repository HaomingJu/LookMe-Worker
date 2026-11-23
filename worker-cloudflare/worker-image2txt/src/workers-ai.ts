import { readBounded } from './bytes';
import type { ImageAnalysisAI } from './types';
import { DEFAULT_ANALYSIS_PROFILE, type AnalysisProfile } from '../../shared/analysis-config';

const MAX_RESPONSE_BYTES = 128 * 1024;
export const PROVIDER_TIMEOUT_MS = 45_000;
export const CAPTION_PROMPT = DEFAULT_ANALYSIS_PROFILE.prompt;

export class ProviderUncertain extends Error {
  constructor(readonly code: string, readonly requestId: string | null = null) { super(code); }
}

export interface Caption {
  text: string;
  requestId: string | null;
}

// 原生 AI binding；不使用外部厂商 Secret，不启用 Gateway/SDK 自动重试。
export async function caption(imageUrl: string, ai: ImageAnalysisAI, timeoutMs = PROVIDER_TIMEOUT_MS, profile: AnalysisProfile = DEFAULT_ANALYSIS_PROFILE): Promise<Caption> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderUncertain('provider_timeout'));
      controller.abort();
    }, timeoutMs);
  });
  let failureCode = 'provider_transport_error';
  try {
    return await Promise.race([timeout, (async () => {
      const response = await ai.run(profile.model, {
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: profile.prompt },
        ] }],
        stream: false,
        max_completion_tokens: profile.max_completion_tokens,
        chat_template_kwargs: { enable_thinking: profile.enable_thinking },
      }, { returnRawResponse: true, signal: controller.signal });
      failureCode = 'provider_response_read_error';
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new ProviderUncertain(`provider_http_${response.status}`);
      }
      if (!response.body) throw new ProviderUncertain('provider_invalid_response');
      const bytes = await readBounded(response.body, MAX_RESPONSE_BYTES, controller.signal);
      failureCode = 'provider_invalid_response';
      const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!data || typeof data !== 'object') throw new ProviderUncertain('provider_invalid_response');
      const { choices, id } = data as Record<string, unknown>;
      const requestId = typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? id : null;
      if (!Array.isArray(choices) || choices.length !== 1 || !choices[0] || typeof choices[0] !== 'object') {
        throw new ProviderUncertain('provider_invalid_response', requestId);
      }
      const choice = choices[0] as { finish_reason?: unknown; message?: { content?: unknown } };
      if (choice.finish_reason !== 'stop') throw new ProviderUncertain('provider_incomplete_response', requestId);
      const text = choice.message?.content;
      if (typeof text !== 'string' || !text.trim() || text.length > 16000) {
        throw new ProviderUncertain('provider_invalid_response', requestId);
      }
      return { text: text.trim(), requestId };
    })()]);
  } catch (error) {
    if (error instanceof ProviderUncertain) throw error;
    throw new ProviderUncertain(failureCode);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
