import worker from '../src/index';
import type { Env } from '../src/types';

// 仅测试：以本地 service binding 模拟 AI.run；不配置真实 AI，禁止付费调用。
export default {
  queue(batch: MessageBatch<unknown>, env: Env & { MOCK_AI: Fetcher }) {
    const ai = {
      run(model: string, input: unknown, options: AiOptions) {
        if (!options.returnRawResponse) throw new Error('测试需要原始响应模式');
        return env.MOCK_AI.fetch('https://mock.invalid/run', {
          method: 'POST', body: JSON.stringify({ model, input }), signal: options.signal,
        });
      },
    } as Ai;
    return worker.queue(batch, { ...env, AI: ai });
  },
};
