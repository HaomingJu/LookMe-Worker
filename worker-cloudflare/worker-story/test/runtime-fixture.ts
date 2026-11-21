// 仅供本地测试，部署入口不引用本文件；没有真实 AI binding。
import { createWorker } from '../src/index';
import type { Env } from '../src/types';
const worker = createWorker(() => Date.parse('2026-11-22T12:00:00Z'));
export default {
  fetch(request: Request, env: { DB: D1Database }) {
    const AI = { async run(_model: string, input: { messages: { content: string }[] }) {
      const data = JSON.parse(input.messages[1].content);
      const photos: { photo_id: string }[] = data.photos;
      const stories = Array.from({ length: data.story_count }, (_, i) => {
        const ids = (i === data.story_count - 1 ? photos.slice(i) : [photos[i]]).map(photo => photo.photo_id);
        return { title: `本地合成故事${i + 1}`, summary: '测试场景总结', source_photo_ids: ids, image_prompt: '2×2四格，统一漫画风格，无文字。',
          panels: Array.from({ length: 4 }, (_, panel) => ({ panel: panel + 1, description: '测试构图', image_prompt: '场景全景与细节特写，无水印。', source_photo_ids: ids })) };
      });
      return Response.json({ id: 'local-fixture', choices: [{ message: { role: 'assistant', content: JSON.stringify({ daily_summary: '合成数据全天回顾', stories }) }, finish_reason: 'stop' }] });
    } } as Env['AI'];
    return worker.fetch(request, { DB: env.DB, AI, STORY_GENERATION_ENABLED: true });
  },
};
