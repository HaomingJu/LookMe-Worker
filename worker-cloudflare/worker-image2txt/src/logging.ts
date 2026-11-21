import type { AnalysisMessage } from './types';

export type Stage = 'validate_message' | 'load_photo' | 'claim_analysis' | 'read_analysis' | 'read_r2'
  | 'check_ai_binding' | 'verify_image' | 'encode_image' | 'mark_submitted' | 'call_provider' | 'save_result' | 'persist_failure';
interface Details {
  code?: string;
  status?: string;
  delay_seconds?: number;
  byte_size?: number;
  result_chars?: number;
  timeout_ms?: number;
  preparation_attempt?: number;
  stage_wall_ms?: number;
}

// 只接受明确列出的诊断字段，绝不展开消息体、Env、图片、模型正文或 Error。
export class MessageLog {
  private stage: Stage = 'validate_message';
  private readonly started: number;
  constructor(private readonly message: Message<unknown>, private readonly key: AnalysisMessage | null,
    private readonly now: () => number) {
    this.started = now();
    this.emit('message_start');
  }

  private emit(event: string, details: Details = {}, level: 'info' | 'warn' = 'info') {
    console[level]({
      service: 'image2txt', event, stage: this.stage,
      message_id: this.message.id, delivery_attempt: this.message.attempts,
      ...(this.key ? { photo_id: this.key.photo_id, analysis_version: this.key.analysis_version } : {}),
      elapsed_wall_ms: Math.max(0, this.now() - this.started), ...details,
    });
  }

  async step<T>(stage: Stage, operation: () => T | Promise<T>, details: Details = {}): Promise<T> {
    this.stage = stage;
    const started = this.now();
    // 强制终止时可能只能留下 start；缺失 end 不是 CPU 超限的证明。
    this.emit('stage_start', details);
    const result = await operation();
    this.emit('stage_end', { ...details, stage_wall_ms: Math.max(0, this.now() - started) });
    return result;
  }

  failure(code: string, details: Details = {}) { this.emit('operation_failed', { ...details, code }, 'warn'); }
  ack(code: string, details: Details = {}) {
    this.message.ack();
    this.emit('message_ack', { ...details, code, status: 'succeeded' });
  }
  retry(code: string, delaySeconds = 60, details: Details = {}) {
    this.message.retry({ delaySeconds });
    this.emit('message_retry', { ...details, code, delay_seconds: delaySeconds }, 'warn');
  }
}
