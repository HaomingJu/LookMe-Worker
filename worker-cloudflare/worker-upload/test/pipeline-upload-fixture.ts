import worker from '../src/index';
let failOnce = true;
function faultEnv(env: any) {
  return { ...env, IMAGE2TXT_QUEUE: { sendBatch(messages: any[]) {
    if (failOnce) { failOnce = false; throw new Error('仅测试：首次投递失败'); }
    return env.IMAGE2TXT_QUEUE.sendBatch(messages);
  } } };
}
// 仅供本地端到端测试，不部署。
export default {
  fetch(request: Request, env: any, ctx: ExecutionContext) { return worker.fetch(request, faultEnv(env), ctx); },
  scheduled(controller: ScheduledController, env: any) { return worker.scheduled(controller, faultEnv(env)); },
};
