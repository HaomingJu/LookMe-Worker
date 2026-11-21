export type StoryAI = Ai<Record<string, { inputs: Omit<ChatCompletionsInput, 'reasoning_effort'> & { reasoning_effort?: 'low' | 'medium' | 'xhigh' }; postProcessedOutputs: ChatCompletionsOutput }>>;
export interface Env {
  DB: D1Database;
  AI?: StoryAI;
  STORY_GENERATION_ENABLED: boolean;
}
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly details: Record<string, unknown> = {}) { super(code); }
}
export interface PhotoSummary {
  photo_id: string;
  uploaded_at: string;
  captured_at: string | null;
  summary: string;
}
export interface Panel {
  panel: number;
  description: string;
  source_photo_ids: string[];
  image_prompt: string;
}
export interface Story {
  title: string;
  summary: string;
  source_photo_ids: string[];
  image_prompt: string;
  panels: Panel[];
}
export interface StoryResult { daily_summary: string; stories: Story[] }
