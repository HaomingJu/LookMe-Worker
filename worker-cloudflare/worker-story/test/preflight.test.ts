import { it, expect } from 'vitest';
import { checkChangeset } from '../scripts/preflight.mjs';
const host = 'story.example.com';
const base = () => ({ added: [{ hostname: host }], updated: [], conflicting: [], removed: [] });
it('只允许配置范围内新增域名或不变的现有域名', () => {
  expect(() => checkChangeset(base(), [host])).not.toThrow();
  expect(() => checkChangeset({ ...base(), added: [], updated: [{ hostname: host, modified: false }] }, [host])).not.toThrow();
});
it.each([
  null, {}, { ...base(), conflicting: [{ hostname: host }] },
  { ...base(), removed: [{ hostname: 'old.example.com' }] },
  { ...base(), updated: [{ hostname: host, modified: true }] },
  { ...base(), added: [{ hostname: 'other.example.com' }] },
])('域名冲突、移除、替换或未知返回结构均停止：%j', value => {
  expect(() => checkChangeset(value, [host])).toThrow();
});
