import { readBounded } from '../../worker-image2txt/src/bytes';
import { HttpError } from './types';
import { parseUsage, type Usage } from './accounting';
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
// 只采用官方明确定义的数值码；不把403/429统一解释为欠费。
function knownCode(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{4}$/.test(value)) return Number(value);
  return undefined;
}
export function classifiedFailure(status?: number, code?: number): HttpError {
  const details = { ...(status === undefined ? {} : { provider_http_status: status }), ...(code === undefined ? {} : { provider_error_code: code }) };
  if (code === 3036) return new HttpError(429, 'model_quota_exceeded', { ...details,
    message: 'Cloudflare Workers AI 每日免费额度已耗尽。这不等于欠费；请等待额度重置，或由账号管理员检查 Workers Paid 与用量。' });
  if (code === 5035) return new HttpError(402, 'model_paid_plan_required', { ...details,
    message: '该模型要求 Workers Paid 计划。请由账号管理员在 Cloudflare 控制台检查套餐；这不表示已有欠款。' });
  if (code === 3040) return new HttpError(503, 'model_capacity_exceeded', { ...details, message: 'Cloudflare AI 暂时没有可用容量，不是欠费；本次不会自动重试。' });
  if (status === 402) return new HttpError(402, 'model_payment_required', { ...details,
    message: '模型服务要求处理付款问题，可能涉及余额或账单。请由账号管理员检查 Cloudflare Billing；本服务不能确认具体欠费金额。' });
  if (status === 429) return new HttpError(429, 'model_rate_limited', { ...details, message: '模型服务返回请求限制，未能确认是余额或额度问题；请检查 Cloudflare 用量，不要连续重试。' });
  return new HttpError(502, 'model_response_error', details);
}
export async function responseFailure(response: Response, parentSignal: AbortSignal): Promise<HttpError> {
  // 读取错误正文最多16KiB/2秒，避免为错误诊断卡到整个模型超时；永不回显正文。
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(2000)]);
  let code: number | undefined;
  let usage: Usage = {};
  try {
    if (response.body) {
      const bytes = await readBounded(response.body, 16384, signal);
      const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (record(body)) {
        usage = parseUsage(body.usage);
        const candidates = [body, ...(record(body.error) ? [body.error] : []), ...(Array.isArray(body.errors) ? body.errors.slice(0, 8).filter(record) : [])];
        code = candidates.map(e => knownCode(e.code)).find(c => c === 3036 || c === 5035 || c === 3040);
      }
    }
  } catch { /* 错误正文非法/超限不影响已知HTTP状态，不输出底层错误。 */ }
  const failure = classifiedFailure(response.status, code);
  return new HttpError(failure.status, failure.code, { ...failure.details, usage });
}
export function bindingFailure(error: unknown): HttpError | null {
  // binding可能直接抛异常；仅从结构化code属性识别已知码，不猜测任意message文本。
  if (!record(error)) return null;
  const code = knownCode(error.code);
  return code === 3036 || code === 5035 || code === 3040 ? classifiedFailure(undefined, code) : null;
}
