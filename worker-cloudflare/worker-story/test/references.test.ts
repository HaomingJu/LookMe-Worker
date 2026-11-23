import { beforeAll, it, expect } from 'vitest';
import { canonical, fingerprints, getProfile, type StoryProfile } from '../src/config';
import { coverageOf, decodeResult, providerPhotos, responseSchema, validateReferenceSchema } from '../src/references';
import { validateResult } from '../src/output';
import type { PhotoSummary } from '../src/types';
let profile: StoryProfile;
const photos: PhotoSummary[] = ['owner-a-photo-1', 'owner-a-photo-2', 'owner-a-photo-3'].map(photo_id => ({ photo_id, summary: '合成摘要', uploaded_at: '2026-11-21T00:00:00Z', captured_at: null }));
function result(groups: string[][] = [['P001', 'P002', 'P003']]) {
  return { daily_summary: '合成日记', stories: groups.map((ids, i) => ({ title: `故事${i + 1}`, summary: '合成故事', image_prompt: '合成四格提示词',
    panels: Array.from({ length: 4 }, (_, j) => ({ panel: j + 1, description: `分镜${j + 1}`, image_prompt: '合成分镜提示词', source_photo_ids: j === 2 ? ids : [ids[0]] })),
  })) };
}
beforeAll(async () => { profile = await getProfile('v3'); });
it('模型只见短编号，映射不修改可信输入记录', () => {
  const encoded = providerPhotos(photos, profile);
  expect(encoded.map(p => p.photo_id)).toEqual(['P001', 'P002', 'P003']);
  expect(encoded.map(p => p.summary)).toEqual(photos.map(p => p.summary));
  expect(JSON.stringify(encoded)).not.toContain('owner-a-photo');
  expect(photos[0].photo_id).toBe('owner-a-photo-1');
});
it('第三格引用有效照片时，故事来源从分镜汇总，不存在两份模型名单冲突', () => {
  const output = result();
  const legacy = { ...output, stories: output.stories.map(s => ({ ...s, source_photo_ids: ['P001'] })) };
  expect(() => validateResult(legacy, 1, providerPhotos(photos, profile))).toThrow('unknown_source_id');
  const decoded = decodeResult(output, 1, photos, profile);
  expect(decoded.stories[0].source_photo_ids).toEqual(photos.map(p => p.photo_id));
  expect(decoded.stories[0].panels[2].source_photo_ids).toEqual(photos.map(p => p.photo_id));
  expect(decoded.stories[0].panels[0].source_photo_ids).toEqual([photos[0].photo_id]);
});
it('动态JSON Schema限定N和每格可选引用，且不污染锁定模板', () => {
  const before = canonical(profile.response_schema);
  const schema = responseSchema(profile, 2, photos) as any;
  const stories = schema.properties.stories;
  const refs = stories.items.properties.panels.items.properties.source_photo_ids;
  expect([stories.minItems, stories.maxItems]).toEqual([2, 2]);
  expect(refs.items.enum).toEqual(['P001', 'P002', 'P003']);
  expect(refs).not.toHaveProperty('uniqueItems'); // 不引入未经验证的供应商 Schema 扩展。
  expect(stories.items.required).not.toContain('source_photo_ids');
  expect(stories.items.properties).not.toHaveProperty('source_photo_ids');
  const next = responseSchema(profile, 1, photos.slice(0, 1)) as any;
  expect(next.properties.stories.items.properties.panels.items.properties.source_photo_ids.items.enum).toEqual(['P001']);
  expect(refs.items.enum).toHaveLength(3);
  expect(canonical(profile.response_schema)).toBe(before);
});
it.each(['P999', 'P000', 'p001', 'P1', 'other-owner-photo', 'owner-a-photo-1'])('不猜测或自动修补非法引用：%s', id => {
  const value = result(); value.stories[0].panels[2].source_photo_ids = [id];
  expect(() => decodeResult(value, 1, photos, profile)).toThrow('unknown_source_id');
});
it('仍拒绝跨故事重复引用和漏图，不删引用来伪造成功', () => {
  expect(() => decodeResult(result([['P001', 'P002'], ['P002', 'P003']]), 2, photos, profile)).toThrow('duplicate_story_source');
  expect(() => decodeResult(result([['P001', 'P002']]), 1, photos, profile)).toThrow('missing_story_sources');
});
it('拒绝单格重复ID、重复分镜号、不足四格和模型自行添加父级名单', () => {
  const duplicateRef = result(); duplicateRef.stories[0].panels[0].source_photo_ids = ['P001', 'P001'];
  expect(() => decodeResult(duplicateRef, 1, photos, profile)).toThrow('duplicate_source_id');
  const duplicatePanel = result(); duplicatePanel.stories[0].panels[1].panel = 1;
  expect(() => decodeResult(duplicatePanel, 1, photos, profile)).toThrow('invalid_panel_order');
  const missingPanel = result(); missingPanel.stories[0].panels.pop();
  expect(() => decodeResult(missingPanel, 1, photos, profile)).toThrow('invalid_panels');
  const extra: any = result(); extra.stories[0].source_photo_ids = ['P999'];
  expect(() => decodeResult(extra, 1, photos, profile)).toThrow('invalid_story_fields');
});
it('只按可信照片位置和已有分镜号排序，文字内容与引用均不修改', () => {
  const value = result([['P001'], ['P002', 'P003']]);
  value.stories.reverse(); value.stories.forEach(s => s.panels.reverse());
  const decoded = decodeResult(value, 2, photos, profile);
  expect(decoded.stories.map(s => s.title)).toEqual(['故事1', '故事2']);
  expect(decoded.stories[0].panels.map(p => p.panel)).toEqual([1, 2, 3, 4]);
  expect(decoded.stories[0].panels.map(p => p.description)).toEqual(['分镜1', '分镜2', '分镜3', '分镜4']);
  expect(value.stories[0].title).toBe('故事2');
});
it('同一短编号在不同请求中只映射到本次用户的可信照片，不共享映射表', () => {
  const other = [{ ...photos[0], photo_id: 'owner-b-photo' }];
  const value = result([['P001']]);
  expect(decodeResult(value, 1, photos.slice(0, 1), profile).stories[0].source_photo_ids).toEqual(['owner-a-photo-1']);
  expect(decodeResult(value, 1, other, profile).stories[0].source_photo_ids).toEqual(['owner-b-photo']);
});
it('v1/v2协议和历史指纹不变，v3不能含第二份父级名单', async () => {
  const hashes = await fingerprints();
  expect(hashes.v1).toBe('577805bb2af000267318bac954c43626e8259f405684eac02f098ca55cd6c77c');
  expect(hashes.v2).toBe('f792a74f9e4605290b954a36a2cf19b4f106e281d9884d93d7bbf50c95c6d920');
  for (const version of ['v1', 'v2']) {
    const old = await getProfile(version);
    expect(providerPhotos(photos, old)).toBe(photos);
    expect(responseSchema(old, 2, photos)).toBe(old.response_schema);
  }
  expect(() => validateReferenceSchema({ ...profile, response_schema: (getSchemaWithParent()) })).toThrow('invalid_story_reference_schema');
  function getSchemaWithParent() {
    const schema: any = structuredClone(profile.response_schema);
    schema.properties.stories.items.properties.source_photo_ids = { type: 'array' };
    return schema;
  }
});

it('v4允许14份输入精选12份分镜，显式披露未引用的2张；v3仍保持严格规则', async () => {
  const all = Array.from({length:14},(_,i)=>({...photos[0],photo_id:`input-${i+1}`}));
  const value = result([['P001','P002','P003','P004'],['P005','P006','P007','P008'],['P009','P010','P011','P012']]);
  expect(()=>decodeResult(value,3,all,profile)).toThrow('missing_story_sources');
  const newest=await getProfile('v4');
  const decoded=decodeResult(value,3,all,newest);
  expect(coverageOf(decoded,all)).toEqual({policy:'representative_panels',input_photo_count:14,referenced_photo_count:12,all_photos_referenced:false,unreferenced_photo_ids:['input-13','input-14']});
  expect(providerPhotos(all,newest)).toHaveLength(14);
  expect((await fingerprints()).v3).toBe('a1c3595474c33b0d77496e7f54e62ada3007a2f46fa419df458ef38f75be09df');
});
it('v4完整引用时显式返回空的未引用清单', async () => {
  const decoded=decodeResult(result(),1,photos,await getProfile('v4'));
  expect(coverageOf(decoded,photos)).toEqual({policy:'representative_panels',input_photo_count:3,referenced_photo_count:3,all_photos_referenced:true,unreferenced_photo_ids:[]});
});
it('精选策略不允许未知来源、重复跨故事引用或不足四格', async () => {
  const newest=await getProfile('v4');
  expect(()=>decodeResult(result([['P999']]),1,photos,newest)).toThrow('unknown_source_id');
  expect(()=>decodeResult(result([['P001'],['P001','P002']]),2,photos,newest)).toThrow('duplicate_story_source');
  const value=result([['P001']]);value.stories[0].panels.pop();
  expect(()=>decodeResult(value,1,photos,newest)).toThrow('invalid_panels');
});
