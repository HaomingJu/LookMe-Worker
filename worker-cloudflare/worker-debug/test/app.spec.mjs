import { test, expect } from '@playwright/test';

const captureBase = Date.parse('2026-11-21T08:10:00+08:00');
const uploadBase = Date.parse('2026-11-22T12:00:00+08:00');
const users = [
  { user_id: '00000000-0000-4000-8000-000000000001', status: 'active', photo_count: 14,
    first_captured_at_ms: captureBase, last_captured_at_ms: captureBase + 13 * 60000, undated_photo_count: 0,
    first_uploaded_at_ms: uploadBase, last_uploaded_at_ms: uploadBase + 13 * 60000 },
  { user_id: '00000000-0000-4000-8000-000000000002', status: 'disabled', photo_count: 1,
    first_captured_at_ms: Date.parse('2026-11-20T09:10:00+08:00'),
    last_captured_at_ms: Date.parse('2026-11-20T09:10:00+08:00'), undated_photo_count: 0,
    first_uploaded_at_ms: uploadBase, last_uploaded_at_ms: uploadBase },
];
const photos = Array.from({ length: 14 }, (_, index) => ({
  photo_id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  captured_at_ms: captureBase + index * 60000, captured_at_source: 'manual', uploaded_at_ms: uploadBase + index * 60000,
  width: index === 3 ? 300 : 800, height: index === 3 ? 1600 : 600, byte_size: 1024, source: 'cli',
  result_text: index === 2 ? null : index === 1
    ? '<img src=x onerror="window.injected=true">这只是摘要文本。'.repeat(25) : `合成影像 ${index + 1}：山间的晨光与远处的树影。`,
  analysis_status: index === 2 ? 'needs_review' : 'succeeded', analysis_version: 'v2', model: 'local-mock',
}));
const image = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#bdd0c6"/><circle cx="590" cy="140" r="56" fill="#fff3cd"/><path d="M0 450L210 170L420 440L580 240L800 470V600H0Z" fill="#487063"/><path d="M0 520L310 350L490 540L800 390V600H0Z" fill="#264a42"/></svg>';
const manyPhotos = count => Array.from({ length: count }, (_, index) => ({ ...photos[index % photos.length],
  photo_id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  captured_at_ms: captureBase + index * 60000 }));
const photoIDs = page => page.locator('.photo-details-button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label').split(' ')[0]));

async function fixtures(page, options = {}) {
  const calls = { timeline: [], images: [], external: [], stories: [], details: [], comics: [], comicImages: [] };
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== 'localhost') { calls.external.push(request.url()); return route.abort(); }
    const authorized = (request.headers().cookie || '').includes('lookme_debug=');
    if (['/api/users', '/api/timeline', '/api/stories', '/api/story', '/api/comics'].includes(url.pathname) || url.pathname.startsWith('/api/comic/') || url.pathname.startsWith('/photo/')) {
      if (!authorized) return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      if (url.pathname === '/api/users') return route.fulfill({ json: { users: options.users ?? users } });
      if (url.pathname === '/api/comics') {
        calls.comics.push(url);
        return options.comics ? options.comics(route,url,calls) : route.fulfill({json:{runs:[],next_cursor:null,date_basis:'uploaded_at_ms'}});
      }
      if (url.pathname.startsWith('/api/comic/')) {
        calls.comicImages.push(url);
        return options.comicImage ? options.comicImage(route,url,calls) : route.fulfill({contentType:'image/svg+xml',body:image});
      }
      if (url.pathname === '/api/stories') {
        calls.stories.push(url);
        return options.stories ? options.stories(route,url,calls) : route.fulfill({json:{runs:[],next_cursor:null,date_basis:'uploaded_at_ms'}});
      }
      if (url.pathname === '/api/story') {
        calls.details.push(url);
        return options.story ? options.story(route,url,calls) : route.fulfill({status:404,json:{error:'story_not_found'}});
      }
      if (url.pathname === '/api/timeline') {
        calls.timeline.push(url);
        if (options.timeline) return options.timeline(route, url, calls);
        const source = url.searchParams.get('user') === users[1].user_id
          ? [{ ...photos[0], captured_at_ms: users[1].last_captured_at_ms, result_text: '第二位用户的合成摘要' }]
          : options.photos ?? photos;
        const date = url.searchParams.get('date');
        const from = Date.parse(`${date}T${url.searchParams.get('start') || '00:00'}:00+08:00`);
        const to = Date.parse(`${date}T${url.searchParams.get('end') || '23:59'}:00+08:00`) + 60000;
        const filtered = source.filter(photo => photo.captured_at_ms !== null && photo.captured_at_ms >= from && photo.captured_at_ms < to)
          .sort((a, b) => a.captured_at_ms - b.captured_at_ms || a.photo_id.localeCompare(b.photo_id));
        const offset = Number(url.searchParams.get('cursor') || 0);
        const limit = Number(url.searchParams.get('limit'));
        return route.fulfill({ json: { photos: filtered.slice(offset, offset + limit),
          next_cursor: offset + limit < filtered.length ? String(offset + limit) : null,
          date_basis: 'captured_at_ms', timezone: 'Asia/Shanghai' } });
      }
      calls.images.push(url);
      if (options.photo) return options.photo(route, url, calls);
      return route.fulfill({ contentType: 'image/svg+xml', body: image });
    }
    return route.continue();
  });
  return calls;
}
async function login(page, waitForPhotos = true) {
  await page.goto('/');
  await expect(page.locator('#login-button')).toBeEnabled();
  await page.locator('#password').fill('local-ui-fixture');
  await page.locator('#login-button').click();
  await expect(page.locator('#workspace')).toBeVisible();
  if (waitForPhotos) await expect(page.locator('#notice')).toHaveText('');
}

test('卡片与图片框统一大小，摘要截断但详情保留全文', async ({ page, context }, testInfo) => {
  const calls = await fixtures(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.locator('.photo-card')).toHaveCount(14);
  await expect(page.locator('#photo-count')).toHaveText('本页 14 张');
  await expect(page.locator('#date')).toHaveValue('2026-11-21');
  await expect(page.locator('.photo-time').first()).toContainText('08:10:00');
  expect(calls.timeline).toHaveLength(1);
  expect(calls.timeline[0].searchParams.get('limit')).toBe('24');
  const sizes = await page.locator('.photo-card').evaluateAll(cards => cards.map(card => [card.clientWidth, card.clientHeight]));
  expect(new Set(sizes.map(size => size.join(':'))).size).toBe(1);
  expect(new Set(await page.locator('.photo-media').evaluateAll(media => media.map(node => node.clientHeight)))).toEqual(new Set([180]));
  expect(await page.locator('.summary').nth(1).evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await expect(page.locator('.badge').nth(2)).toHaveText('needs_review');
  await expect(page.locator('.summary').nth(2)).toHaveText('—');
  await page.locator('.photo-details-button').nth(1).click();
  await expect(page.locator('#info-dialog')).toBeVisible();
  await expect(page.locator('#info-summary')).toHaveText(photos[1].result_text);
  await expect(page.locator('#info-metadata')).toContainText('2026-11-22');
  await expect(page.locator('#info-metadata')).toContainText('2026-11-21');
  await expect(page.locator('#info-summary img')).toHaveCount(0);
  await page.locator('#close-info').click();
  await expect(page.locator('#info-dialog')).not.toBeVisible();
  expect(await page.locator('.photo-card').evaluateAll(cards => cards.map(card => [card.clientWidth, card.clientHeight]))).toEqual(sizes);
  await expect(page.locator('.photo-media img').first()).toBeVisible();
  await page.locator('.photo-media img').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#large-caption')).toContainText('2026-11-21 08:10:00 UTC+8');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('desktop-paged.png') });
  expect((await context.cookies()).find(cookie => cookie.name === 'lookme_debug')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
  await expect(page.locator('#theme, #logout, #user-title, #strip, #timeline-controls')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(calls.external).toEqual([]);
});

test('大量照片每页最多24张，前后翻页不追加或自动读取下一页', async ({ page }) => {
  const all = manyPhotos(62);
  const calls = await fixtures(page, { photos: all });
  await login(page);
  await expect(page.locator('.photo-card')).toHaveCount(24);
  expect(await photoIDs(page)).toEqual(all.slice(0, 24).map(photo => photo.photo_id));
  expect(calls.timeline).toHaveLength(1);
  await expect(page.locator('#previous-page')).toBeDisabled();
  await expect(page.locator('#next-page')).toBeEnabled();
  await page.locator('#next-page').click();
  await expect(page.locator('#page-label')).toHaveText('第 2 页');
  await expect(page.locator('#notice')).toHaveText('');
  expect(await photoIDs(page)).toEqual(all.slice(24, 48).map(photo => photo.photo_id));
  expect(calls.timeline).toHaveLength(2);
  expect(calls.timeline.at(-1).searchParams.get('cursor')).toBe('24');
  await page.locator('#next-page').click();
  await expect(page.locator('#photo-count')).toHaveText('本页 14 张');
  await expect(page.locator('#page-label')).toHaveText('第 3 页');
  await expect(page.locator('#next-page')).toBeDisabled();
  expect(await photoIDs(page)).toEqual(all.slice(48).map(photo => photo.photo_id));
  await page.locator('#previous-page').click();
  await expect(page.locator('#notice')).toHaveText('');
  expect(await photoIDs(page)).toEqual(all.slice(24, 48).map(photo => photo.photo_id));
  await page.locator('#previous-page').click();
  await expect(page.locator('#notice')).toHaveText('');
  expect(await photoIDs(page)).toEqual(all.slice(0, 24).map(photo => photo.photo_id));
  expect(calls.timeline.at(-1).searchParams.has('cursor')).toBe(false);
});

test('筛选和刷新重置到第一页，使用已应用的拍摄时间', async ({ page }) => {
  const calls = await fixtures(page, { photos: manyPhotos(62) });
  await login(page);
  await page.locator('#next-page').click();
  await expect(page.locator('#notice')).toHaveText('');
  await page.locator('#start-time').fill('08:10');
  await page.locator('#end-time').fill('08:10');
  await page.locator('#apply').click();
  await expect(page.locator('#photo-count')).toHaveText('本页 1 张');
  await expect(page.locator('#page-label')).toHaveText('第 1 页');
  expect(calls.timeline.at(-1).searchParams.has('cursor')).toBe(false);
  await page.locator('#date').fill('2026-11-19');
  await page.locator('#refresh').click();
  await expect(page.locator('#date')).toHaveValue('2026-11-21');
  await expect(page.locator('#photo-count')).toHaveText('本页 1 张');
  await page.locator('#full-day').click();
  await expect(page.locator('#photo-count')).toHaveText('本页 24 张');
  await expect(page.locator('#start-time')).toHaveValue('00:00');
  await expect(page.locator('#end-time')).toHaveValue('23:59');
});

test('无效时间不发请求，空拍摄日期不回退至上传日期', async ({ page }) => {
  const calls = await fixtures(page);
  await login(page);
  const count = calls.timeline.length;
  await page.locator('#start-time').fill('18:00');
  await page.locator('#end-time').fill('08:00');
  await page.locator('#apply').click();
  expect(await page.locator('#end-time').evaluate(input => input.validity.customError)).toBe(true);
  expect(calls.timeline).toHaveLength(count);
  await page.locator('#full-day').click();
  await expect(page.locator('#notice')).toHaveText('');
  await page.locator('#next-day').click();
  await expect(page.locator('#date')).toHaveValue('2026-11-22');
  await expect(page.locator('#photo-count')).toHaveText('本页 0 张');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#pager')).toBeHidden();
});

test('会话恢复和用户切换保持照片归属及拍摄日期', async ({ page }) => {
  const calls = await fixtures(page);
  await login(page);
  await page.reload();
  await expect(page.locator('.photo-card')).toHaveCount(14);
  await page.locator('.user-button').nth(1).click();
  await expect(page.locator('.summary')).toHaveText('第二位用户的合成摘要');
  await expect(page.locator('#date')).toHaveValue('2026-11-20');
  await expect(page.locator('.user-button').nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#page-label')).toHaveText('第 1 页');
  expect(calls.timeline.at(-1).searchParams.get('user')).toBe(users[1].user_id);
});

test('侧栏可收起展开，并保留用户、视图与每页卡片尺寸', async ({ page }, testInfo) => {
  await fixtures(page);
  await login(page);
  const width = await page.locator('.main-content').evaluate(node => node.clientWidth);
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.locator('.main-content').evaluate(node => node.clientWidth)).toBeGreaterThan(width);
  await expect(page.locator('#photos-view')).toHaveAttribute('aria-current', 'page');
  expect(new Set(await page.locator('.photo-card').evaluateAll(cards => cards.map(card => card.clientHeight)))).toEqual(new Set([378]));
  await page.screenshot({ path: testInfo.outputPath('desktop-collapsed.png') });
  await page.reload();
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('.user-id').first()).toHaveText(users[0].user_id);
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded', 'true');
});

test('照片与故事分开显示，故事入口不触发照片读取或模型请求', async ({ page }) => {
  const calls = await fixtures(page);
  await login(page);
  const count = calls.timeline.length;
  await page.locator('#stories-view').click();
  await expect(page.locator('#stories-panel')).toBeVisible();
  await expect(page.locator('#photos-panel')).toBeHidden();
  await expect(page.locator('#story-status')).toContainText('暂无已登记故事');
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await expect(page.locator('#start-time')).toBeDisabled();
  await expect(page.locator('#end-time')).toBeDisabled();
  await page.locator('#date').fill('2026-11-20');
  await page.locator('#apply').click();
  expect(calls.timeline).toHaveLength(count);
  await page.locator('.user-button').nth(1).click();
  await expect(page.locator('#stories-view')).toHaveAttribute('aria-current', 'page');
  expect(calls.timeline).toHaveLength(count);
  await page.locator('#photos-view').click();
  await expect(page.locator('#stories-panel')).toBeHidden();
  await expect(page.locator('#photos-panel')).toBeVisible();
  await expect(page.locator('.summary')).toHaveText('第二位用户的合成摘要');
  expect(calls.external).toEqual([]);
});

test('分页请求未完成时切换用户，旧页不能覆盖当前用户', async ({ page }) => {
  let release;
  let started;
  const wait = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  await fixtures(page, { timeline: async (route, url) => {
    if (url.searchParams.get('user') === users[1].user_id) return route.fulfill({ json: { photos: [{ ...photos[0], result_text: '新用户照片' }], next_cursor: null } });
    if (!url.searchParams.has('cursor')) return route.fulfill({ json: { photos, next_cursor: '24' } });
    started();
    await wait;
    return route.fulfill({ json: { photos, next_cursor: null } }).catch(() => {});
  } });
  await login(page);
  await page.locator('#next-page').click();
  await ready;
  await page.locator('.user-button').nth(1).click();
  await expect(page.locator('.summary')).toHaveText('新用户照片');
  release();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await expect(page.locator('#page-label')).toHaveText('第 1 页');
});

test('分页失败可以重试该页或退回上一页，不伪装加载成功', async ({ page }) => {
  let failed = false;
  const calls = await fixtures(page, { timeline: (route, url) => {
    if (!url.searchParams.has('cursor')) return route.fulfill({ json: { photos, next_cursor: '24' } });
    if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'storage_unavailable' } }); }
    return route.fulfill({ json: { photos: photos.slice(0, 2), next_cursor: null } });
  } });
  await login(page);
  await page.locator('#next-page').click();
  await expect(page.locator('#notice')).toHaveText('数据读取失败。');
  await expect(page.locator('#page-label')).toHaveText('第 2 页');
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await expect(page.locator('#retry-page')).toBeVisible();
  await expect(page.locator('#previous-page')).toBeEnabled();
  await page.locator('#retry-page').click();
  await expect(page.locator('#photo-count')).toHaveText('本页 2 张');
  expect(calls.timeline.at(-1).searchParams.get('cursor')).toBe('24');
  await page.locator('#previous-page').click();
  await expect(page.locator('#photo-count')).toHaveText('本页 14 张');
});

test('图片失败可重试，懒加载仅针对当前页', async ({ page }) => {
  let failed = false;
  const all = manyPhotos(62);
  const calls = await fixtures(page, { photos: all, photo: route => {
    if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'storage_unavailable' } }); }
    return route.fulfill({ contentType: 'image/svg+xml', body: image });
  } });
  await login(page);
  const first = page.locator('.photo-media').first();
  await expect(first.locator('button')).toBeVisible();
  await first.locator('button').click();
  await expect(first.locator('img')).toBeVisible();
  await expect(first.locator('button')).toBeHidden();
  expect(calls.images.every(url => all.slice(0, 24).some(photo => url.pathname.endsWith(photo.photo_id)))).toBe(true);
  expect(calls.images.every(url => url.searchParams.get('user') === users[0].user_id)).toBe(true);
});

test('未知拍摄时间单独计数，不使用最后上传日期作为默认日期', async ({ page }) => {
  const undated = { ...users[0], photo_count: 3, undated_photo_count: 3, last_captured_at_ms: null,
    last_uploaded_at_ms: Date.parse('2020-01-01T12:00:00+08:00') };
  await fixtures(page, { users: [undated], photos: [] });
  await login(page);
  await expect(page.locator('.user-button')).toContainText('3 张缺少拍摄时间');
  await expect(page.locator('#date')).not.toHaveValue('2020-01-01');
  await expect(page.locator('#photo-count')).toHaveText('本页 0 张');
});

test('会话失效清除当前页、详情、大图及用户信息', async ({ page, context }) => {
  await fixtures(page);
  await login(page);
  await page.locator('.photo-details-button').first().click();
  await context.clearCookies();
  await page.evaluate(() => document.getElementById('refresh').click());
  await expect(page.locator('#login-error')).toHaveText('会话过期，请登录。');
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#info-dialog')).not.toBeVisible();
  await expect(page.locator('#info-summary')).toHaveText('');
  await expect(page.locator('.photo-card, .user-button')).toHaveCount(0);
  await expect(page.locator('#large-photo')).not.toHaveAttribute('src');
});

test('错误口令仍被拒绝，空用户列表正常显示', async ({ page }) => {
  await fixtures(page, { users: [] });
  await page.goto('/');
  await expect(page.locator('#login-button')).toBeEnabled();
  await page.locator('#password').fill('wrong-fixture');
  await page.locator('#login-button').click();
  await expect(page.locator('#login-error')).toHaveText('口令错误。');
  await expect(page.locator('#password')).toHaveValue('');
  await page.locator('#password').fill('local-ui-fixture');
  await page.locator('#login-button').click();
  await expect(page.locator('#empty')).toHaveText('无用户');
  await expect(page.locator('#empty')).toBeVisible();
});

test('移动端侧栏可收起，无横向溢出，系统深色设置不改变主题', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await fixtures(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await expect(page.locator('.photo-media img').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('html').evaluate(root => getComputedStyle(root).colorScheme)).toBe('light');
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#user-list')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mobile-collapsed.png') });
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#user-list')).toBeVisible();
  await expect(page.locator('#theme, #logout, #user-title')).toHaveCount(0);
});

test('浏览器存储禁用时仍可收起侧栏和切换视图', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }));
  await fixtures(page);
  await login(page);
  await page.locator('#toggle-sidebar').click();
  await expect(page.locator('#toggle-sidebar')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#stories-view').click();
  await expect(page.locator('#stories-panel')).toBeVisible();
  await page.locator('#photos-view').click();
  await expect(page.locator('.photo-card')).toHaveCount(14);
});

const storyRun = {
  run_id: '30000000-0000-4000-8000-000000000001', story_date: '2026-11-22', timezone: 'Asia/Shanghai', date_basis: 'uploaded_at_ms',
  model: '@cf/qwen/qwen3.8-27b', story_version: 'v5', analysis_version: 'v2', status: 'succeeded', created_at_ms: uploadBase,
  story_count: 1, daily_summary: '合成日记 <img src=x onerror="window.storyInjected=true">', request_duration_ms: 89000,
  usage: { prompt_tokens: 2643, completion_tokens: 1292, total_tokens: 3935 }, model_timings: { total_ms: 87871 },
  cost: { currency: 'USD', estimated_usd: 0.00532375, is_estimate: true, basis: 'all_input_at_standard_rate',
    pricing: { input: 0.45, output: 3.2, cached_input: 0.05, verified_at: '2026-11-23', source: 'https://developers.cloudflare.com/' },
    note: '公开价格估算，不是账单' },
};
const storyResult = { coverage: { input_photo_count: 2, referenced_photo_count: 1, unreferenced_photo_ids: [photos[1].photo_id] },
  stories: [{ story_id: '40000000-0000-4000-8000-000000000001', title: '合成故事标题', summary: '故事摘要',
    source_photo_ids: [photos[0].photo_id], image_prompt: '<script>window.storyInjected=true</script>整图提示词'.repeat(20),
    panels: Array.from({ length: 4 }, (_, i) => ({ panel: i + 1, description: '分镜事实', image_prompt: '分镜提示词', source_photo_ids: [photos[0].photo_id] })) }] };

test('故事网站展示原始模型、耗时、费用和四格，文字安全渲染且手机不溢出', async ({ page }, testInfo) => {
  const calls = await fixtures(page, {
    stories: route => route.fulfill({ json: { runs: [storyRun], next_cursor: null } }),
    story: route => route.fulfill({ json: { status: 'succeeded', result: storyResult } }),
  });
  await login(page); await page.locator('#stories-view').click();
  await expect(page.locator('#date-label')).toHaveText('故事日期（上传日）');
  await expect(page.locator('#date')).toHaveValue('2026-11-22');
  await expect(page.locator('.story-run')).toHaveCount(1);
  await expect(page.locator('.story-run')).toContainText('@cf/qwen/qwen3.8-27b');
  await expect(page.locator('.story-run')).toContainText('89.00 秒');
  await expect(page.locator('.story-run')).toContainText('2643');
  await expect(page.locator('.story-run')).toContainText('USD 0.00532375');
  await expect(page.locator('.story-run')).toContainText('估算，非实际账单');
  await page.getByRole('button', { name: '查看故事与四格提示词' }).click();
  await expect(page.locator('.saved-story')).toHaveCount(1);
  await expect(page.locator('.saved-story')).not.toHaveAttribute('open');
  await expect(page.locator('.story-panel-item').first()).toBeHidden();
  await expect(page.locator('#story-list')).not.toContainText('完整输入');
  await expect(page.locator('#story-list')).not.toContainText('未引用：');
  await expect(page.locator('#story-list')).not.toContainText(photos[1].photo_id);
  await page.locator('.story-toggle').click();
  await expect(page.locator('.saved-story')).toHaveAttribute('open', '');
  await expect(page.locator('.story-panel-item')).toHaveCount(4);
  await expect(page.locator('.saved-story')).toContainText(storyResult.stories[0].story_id);
  await expect(page.locator('#story-list img')).toHaveCount(0);
  await expect(page.locator('#story-list script')).toHaveCount(0);
  expect(await page.evaluate(() => window.storyInjected)).toBeUndefined();
  expect(calls.details[0].searchParams.get('user')).toBe(users[0].user_id);
  expect(calls.external).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('stories-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('stories-mobile.png') });
  await page.locator('.story-panels').scrollIntoViewIfNeeded();
  await expect(page.locator('.story-panel-item').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('stories-mobile-panels.png') });
});

test('故事分页、失败重试与用户切换不混淆批次', async ({ page }) => {
  let failed = false;
  const calls = await fixtures(page, { stories: (route, url) => {
    if (url.searchParams.get('user') === users[1].user_id) return route.fulfill({ json: { runs: [], next_cursor: null } });
    if (!url.searchParams.has('cursor')) return route.fulfill({ json: { runs: [storyRun], next_cursor: 'next' } });
    if (!failed) { failed = true; return route.fulfill({ status: 503, json: { error: 'storage_unavailable' } }); }
    return route.fulfill({ json: { runs: [{ ...storyRun, run_id: '30000000-0000-4000-8000-000000000002', status: 'needs_review', cost: null, usage: {} }], next_cursor: null } });
  } });
  await login(page); await page.locator('#stories-view').click();
  await expect(page.locator('.story-run')).toHaveCount(1);
  await page.locator('#more-stories').click();
  await expect(page.locator('#retry-stories')).toBeVisible();
  await page.locator('#retry-stories').click();
  await expect(page.locator('.story-run')).toHaveCount(2);
  await expect(page.locator('.story-run').nth(1)).toContainText('未知（非零费用）');
  await page.locator('.user-button').nth(1).click();
  await expect(page.locator('.story-run')).toHaveCount(0);
  await expect(page.locator('#story-status')).toContainText('暂无已登记故事');
  expect(calls.stories.at(-1).searchParams.get('user')).toBe(users[1].user_id);
});

test('故事详情请求迟到不能恢复已切走用户的数据，会话过期清除故事', async ({ page }) => {
  let release; let started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  let expired = false;
  await fixtures(page, {
    stories: route => expired ? route.fulfill({ status: 401, json: { error: 'unauthorized' } }) : route.fulfill({ json: { runs: [storyRun], next_cursor: null } }),
    story: async route => { started(); await gate; return route.fulfill({ json: { result: storyResult } }).catch(() => {}); },
  });
  await login(page); await page.locator('#stories-view').click();
  await page.getByRole('button', { name: '查看故事与四格提示词' }).click(); await ready;
  await page.locator('#photos-view').click(); release();
  await expect(page.locator('.saved-story')).toHaveCount(0);
  expired = true; await page.locator('#stories-view').click();
  await expect(page.locator('#login-screen')).toBeVisible();
  await expect(page.locator('.story-run')).toHaveCount(0);
});


test('故事独立折叠、键盘切换和整批收起不会重复读取或丢失全文', async ({ page }) => {
  const two = { ...storyResult, stories: [storyResult.stories[0], { ...storyResult.stories[0], story_id: '40000000-0000-4000-8000-000000000002', title: '第二个故事' }] };
  const calls = await fixtures(page, {
    stories: route => route.fulfill({ json: { runs: [{ ...storyRun, story_count: 2 }], next_cursor: null } }),
    story: route => route.fulfill({ json: { status: 'succeeded', result: two } }),
  });
  await login(page); await page.locator('#stories-view').click();
  const load = page.getByRole('button', { name: '查看故事与四格提示词' });
  await expect(load).toHaveAttribute('aria-expanded', 'false'); await load.click();
  const stories = page.locator('.saved-story'); await expect(stories).toHaveCount(2);
  await expect(stories.nth(0)).not.toHaveAttribute('open'); await expect(stories.nth(1)).not.toHaveAttribute('open');
  const first = stories.nth(0).locator('summary'); await first.focus(); await page.keyboard.press('Enter');
  await expect(stories.nth(0)).toHaveAttribute('open', ''); await expect(stories.nth(1)).not.toHaveAttribute('open');
  await expect(stories.nth(0).locator('.saved-story-body')).toContainText(two.stories[0].image_prompt);
  await first.focus(); await page.keyboard.press('Space'); await expect(stories.nth(0)).not.toHaveAttribute('open');
  await stories.nth(1).locator('summary').click(); await expect(stories.nth(1)).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '收起故事列表' }).click();
  await expect(page.locator('.story-content')).toBeHidden();
  const expand = page.getByRole('button', { name: '展开故事列表' }); await expect(expand).toHaveAttribute('aria-expanded', 'false'); await expand.click();
  await expect(page.locator('.story-content')).toBeVisible(); await expect(stories.nth(1)).toHaveAttribute('open', '');
  expect(calls.details).toHaveLength(1); expect(calls.external).toEqual([]);
});


const comicRun = { run_id:'50000000-0000-4000-8000-000000000001', story_id:'40000000-0000-4000-8000-000000000001', story_title:'测试故事',
  model:'@cf/black-forest-labs/flux-2-klein-9b', profile_version:'v1', status:'succeeded', provider_request_id:'comic-provider',
  created_at_ms:uploadBase+1000, updated_at_ms:uploadBase+2000, reference_photo_ids:[photos[0].photo_id], may_have_been_billed:true,
  image:{path:'/api/comic/50000000-0000-4000-8000-000000000001/image?user='+users[0].user_id,mime_type:'image/png',byte_size:4,sha256:'b'.repeat(64),width:1024,height:1536} };
test('漫画视图显示模型和成图元信息，私有图片加载且与照片/故事视图隔离', async ({ page, context }) => {
  const calls=await fixtures(page,{comics:(route,url)=>url.searchParams.get('user')===users[1].user_id ? route.fulfill({json:{runs:[],next_cursor:null,date_basis:'uploaded_at_ms'}}) : route.fulfill({json:{runs:[comicRun],next_cursor:null,date_basis:'uploaded_at_ms'}})});
  await login(page); await page.locator('#comics-view').click();
  await expect(page.locator('#comics-panel')).toBeVisible(); await expect(page.locator('#photos-panel')).toBeHidden(); await expect(page.locator('#stories-panel')).toBeHidden();
  await expect(page.locator('#date-label')).toHaveText('漫画日期（故事上传日）');
  await expect(page.locator('.comic-run')).toHaveCount(1); await expect(page.locator('.comic-run')).toContainText(comicRun.model); await expect(page.locator('.comic-run')).toContainText('1024 × 1536');
  await page.locator('.comic-image').scrollIntoViewIfNeeded(); await expect(page.locator('.comic-image')).toBeVisible(); expect(calls.comics).toHaveLength(1); expect(calls.comicImages).toHaveLength(1);
  expect(calls.timeline).toHaveLength(1); expect(calls.stories).toHaveLength(0); expect(calls.external).toEqual([]);
  await page.locator('.user-button').nth(1).click(); await expect(page.locator('.comic-run')).toHaveCount(0); await expect(page.locator('#comics-status')).toContainText('暂无漫画记录');
  expect(calls.comics.at(-1).searchParams.get('user')).toBe(users[1].user_id);
  expect((await context.cookies()).find(c=>c.name==='lookme_debug')).toMatchObject({httpOnly:true,secure:true,sameSite:'Strict'});
});
