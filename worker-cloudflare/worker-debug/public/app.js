(() => {
  'use strict';

  const PAGE_SIZE = 24;
  const ids = ['login-screen', 'login-form', 'password', 'login-button', 'login-error', 'workspace',
    'user-list', 'user-count', 'toggle-sidebar', 'refresh', 'filters', 'date', 'start-time', 'end-time',
    'previous-day', 'next-day', 'full-day', 'apply', 'zone-note', 'notice', 'photos-panel', 'stories-panel',
    'story-status', 'photo-count', 'empty', 'photo-grid', 'pager', 'previous-page', 'next-page', 'page-label',
    'retry-page', 'lightbox', 'close-lightbox', 'large-photo', 'large-caption', 'info-dialog', 'close-info',
    'info-summary', 'info-metadata', 'date-label', 'story-list', 'more-stories', 'retry-stories'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  const state = { users: [], user: null, view: 'photos', range: null, photos: [],
    pageIndex: 0, pageCursors: [null], nextCursor: null, epoch: 0, loading: false,
    controller: null, images: new Map(), lightbox: null, storyCursor: null, storyCount: 0 };
  const errors = { unauthorized: '会话过期，请登录。', debug_not_configured: '未配置访问口令。',
    storage_unavailable: '数据读取失败。', user_not_found: '用户不存在，请刷新。',
    invalid_date: '日期无效。', invalid_time_range: '结束时间不能早于开始时间。',
    story_not_found: '故事批次不存在。', invalid_cursor: '分页游标失效，请重新筛选。', photo_missing: '照片不存在。' };
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Etc/GMT-8',
    year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Etc/GMT-8',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

  function dateValue(ms) {
    const parts = Object.fromEntries(dateFormat.formatToParts(ms).map(part => [part.type, part.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  }
  function timestamp(ms) {
    return ms == null ? '—' : `${dateValue(ms)} ${timeFormat.format(ms)} UTC+8`;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function notice(text = '', error = false) {
    ui.notice.textContent = text;
    ui.notice.classList.toggle('error', error);
  }
  function message(error) {
    if (error.name === 'TimeoutError') return '请求超时。';
    return errors[error.code] || '请求失败，请重试。';
  }
  async function response(path, options = {}) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000);
    const result = await fetch(path, { credentials: 'same-origin', cache: 'no-cache',
      redirect: 'error', ...options, signal });
    if (!result.ok) {
      const data = await result.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || 'request_failed'), { status: result.status, code: data.error });
    }
    return result;
  }
  async function json(path, options) {
    return (await response(path, options)).json();
  }
  function fail(error, epoch) {
    if (epoch !== state.epoch || error.name === 'AbortError') return;
    if (error.status === 401) showLogin(errors.unauthorized);
    else notice(message(error), true);
  }
  function unloadImage(media) {
    const entry = state.images.get(media);
    if (!entry) return;
    state.images.delete(media);
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.img.remove();
    media.querySelector('span').textContent = '';
  }
  function clearLightbox() {
    state.lightbox?.controller.abort();
    if (state.lightbox?.url) URL.revokeObjectURL(state.lightbox.url);
    state.lightbox = null;
    ui['large-photo'].removeAttribute('src');
    ui['large-caption'].textContent = '';
  }
  function clearInfo() {
    ui['info-summary'].textContent = '';
    ui['info-metadata'].replaceChildren();
  }
  function resetPhotos() {
    state.epoch++;
    state.controller?.abort();
    state.controller = null;
    imageObserver.disconnect();
    for (const media of state.images.keys()) unloadImage(media);
    if (ui.lightbox.open) ui.lightbox.close();
    if (ui['info-dialog'].open) ui['info-dialog'].close();
    clearLightbox();
    clearInfo();
    ui['photo-grid'].replaceChildren();
    state.photos = [];
    ui['story-list'].replaceChildren();
    ui['more-stories'].hidden = true;
    ui['retry-stories'].hidden = true;
    ui['story-status'].textContent = '';
    state.storyCursor = null; state.storyCount = 0;
    state.nextCursor = null;
    state.loading = false;
    ui.empty.hidden = true;
    ui['retry-page'].hidden = true;
    ui.pager.hidden = true;
    ui['photo-count'].textContent = '';
  }
  function updateView() {
    const stories = state.view === 'stories';
    ui['photos-panel'].hidden = stories;
    ui['stories-panel'].hidden = !stories;
    ui.filters.dataset.view = state.view;
    ui.filters.setAttribute('aria-label', stories ? '按故事上传日期筛选' : '按拍摄时间筛选');
    for (const node of document.querySelectorAll('.photo-filter')) node.hidden = stories;
    ui['start-time'].disabled = stories;
    ui['end-time'].disabled = stories;
    ui['end-time'].setCustomValidity('');
    ui['date-label'].textContent = stories ? '故事日期（上传日）' : '拍摄日期';
    ui['zone-note'].textContent = stories ? 'UTC+8 · 按上传日 · 只读历史结果' : 'UTC+8 · 含结束分钟';
  }
  function showLogin(error = '') {
    resetPhotos();
    state.users = [];
    state.user = null;
    state.range = null;
    state.view = 'photos';
    state.pageIndex = 0;
    state.pageCursors = [null];
    ui['user-list'].replaceChildren();
    ui['user-count'].textContent = '';
    ui['story-status'].textContent = '';
    updateView();
    ui.workspace.hidden = true;
    ui['login-screen'].hidden = false;
    ui.password.value = '';
    ui['login-error'].textContent = error;
    notice();
    if (error) ui.password.focus();
  }
  function renderUsers() {
    ui['user-list'].replaceChildren(...state.users.map((user, index) => {
      const group = element('div', 'user-group');
      const button = element('button', 'user-button');
      const selected = user.user_id === state.user?.user_id;
      button.type = 'button';
      button.setAttribute('aria-current', selected ? 'page' : 'false');
      button.setAttribute('aria-label', `用户 ${index + 1}，${user.user_id}`);
      const label = element('span', 'user-label');
      label.append(element('strong', '', `用户 ${index + 1}`),
        element('small', '', `${user.photo_count} 张 · ${user.status === 'active' ? '启用' : '停用'}`));
      if (user.undated_photo_count) label.append(element('small', '', `${user.undated_photo_count} 张缺少拍摄时间`));
      label.append(element('small', 'user-id', user.user_id));
      button.append(element('span', 'user-avatar', String(index + 1).padStart(2, '0')), label);
      button.title = user.user_id;
      button.addEventListener('click', () => selectUser(user));
      group.append(button);
      if (selected) {
        const links = element('div', 'view-links');
        for (const [view, name] of [['photos', '照片'], ['stories', '故事']]) {
          const link = element('button', 'view-button', name);
          link.id = `${view}-view`;
          link.type = 'button';
          link.setAttribute('aria-current', state.view === view ? 'page' : 'false');
          link.addEventListener('click', () => switchView(view));
          links.append(link);
        }
        group.append(links);
      }
      return group;
    }));
    ui['user-count'].textContent = String(state.users.length);
  }
  async function loadUsers(initial = false) {
    resetPhotos();
    const epoch = state.epoch;
    const controller = state.controller = new AbortController();
    ui.refresh.disabled = true;
    notice('加载用户…');
    try {
      const data = await json('/api/users', { signal: controller.signal });
      if (epoch !== state.epoch) return;
      state.users = data.users;
      ui['login-screen'].hidden = true;
      ui.workspace.hidden = false;
      const selected = state.users.find(user => user.user_id === state.user?.user_id);
      if (selected || state.users.length) {
        selectUser(selected || state.users[0], Boolean(selected));
      } else {
        state.user = null;
        state.range = null;
        renderUsers();
        updateView();
        ui.empty.textContent = '无用户';
        ui.empty.hidden = false;
        ui['story-status'].textContent = '无用户';
        notice();
      }
    } catch (error) {
      if (epoch !== state.epoch || error.name === 'AbortError') return;
      if (ui.workspace.hidden) showLogin(initial && error.status === 401 ? '' : message(error));
      else fail(error, epoch);
    } finally {
      ui.refresh.disabled = false;
    }
  }
  function restoreRange() {
    if (!state.range) return;
    ui.date.value = state.range.date;
    ui['start-time'].value = state.range.start;
    ui['end-time'].value = state.range.end;
  }
  function selectUser(user, preserveRange = false) {
    state.user = user;
    renderUsers();
    updateView();
    if (!preserveRange) {
      ui.date.value = dateValue((state.view === 'stories' ? user.last_uploaded_at_ms : user.last_captured_at_ms) ?? Date.now());
      ui['start-time'].value = '00:00';
      ui['end-time'].value = '23:59';
    } else restoreRange();
    applyFilters();
  }
  function switchView(view) {
    if (!state.user || state.view === view) return;
    state.view = view;
    if (state.range) state.range.date = dateValue((view === 'stories' ? state.user.last_uploaded_at_ms : state.user.last_captured_at_ms) ?? Date.now());
    restoreRange();
    renderUsers();
    updateView();
    applyFilters();
    document.getElementById(`${view}-view`).focus();
  }
  function validRange() {
    ui['end-time'].setCustomValidity(state.view === 'photos' && ui['start-time'].value > ui['end-time'].value
      ? '结束时间不能早于开始时间。' : '');
    return ui.filters.reportValidity();
  }
  function applyFilters() {
    if (!state.user || !validRange()) return;
    resetPhotos();
    state.range = { date: ui.date.value, start: ui['start-time'].value, end: ui['end-time'].value };
    state.pageIndex = 0;
    state.pageCursors = [null];
    ui['previous-day'].disabled = state.range.date === ui.date.min;
    ui['next-day'].disabled = state.range.date === ui.date.max;
    if (state.view === 'photos') loadPage(0);
    else loadStories();
  }
  function updatePager() {
    ui['page-label'].textContent = `第 ${state.pageIndex + 1} 页`;
    ui['previous-page'].disabled = state.loading || state.pageIndex === 0;
    ui['next-page'].disabled = state.loading || !state.nextCursor;
    ui.pager.hidden = state.view !== 'photos' || !(state.photos.length || state.loading || state.pageIndex > 0 || !ui['retry-page'].hidden);
  }
  async function loadPage(index) {
    if (state.loading || !state.user || !state.range || state.view !== 'photos' || index < 0 || index >= state.pageCursors.length) return;
    const cursor = state.pageCursors[index];
    resetPhotos();
    state.pageIndex = index;
    state.loading = true;
    const epoch = state.epoch;
    const controller = state.controller = new AbortController();
    updatePager();
    notice('加载照片…');
    try {
      const query = new URLSearchParams({ user: state.user.user_id, ...state.range, limit: String(PAGE_SIZE) });
      if (cursor) query.set('cursor', cursor);
      const data = await json(`/api/timeline?${query}`, { signal: controller.signal });
      if (epoch !== state.epoch) return;
      state.photos = data.photos;
      state.nextCursor = data.next_cursor;
      state.pageCursors = state.pageCursors.slice(0, index + 1);
      if (state.nextCursor) state.pageCursors.push(state.nextCursor);
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < state.photos.length; index++) fragment.append(card(state.photos[index], index));
      ui['photo-grid'].append(fragment);
      for (const media of ui['photo-grid'].querySelectorAll('.photo-media')) imageObserver.observe(media);
      ui['photo-count'].textContent = `本页 ${state.photos.length} 张`;
      ui.empty.textContent = '无照片';
      ui.empty.hidden = state.photos.length !== 0;
      notice();
    } catch (error) {
      fail(error, epoch);
      if (epoch === state.epoch && error.name !== 'AbortError') ui['retry-page'].hidden = false;
    } finally {
      if (epoch === state.epoch) {
        state.loading = false;
        updatePager();
      }
    }
  }
  function metadata(rows) {
    const list = element('dl', 'info-metadata story-metadata');
    for (const [label, value] of rows) list.append(element('dt', '', label), element('dd', '', value ?? '未返回'));
    return list;
  }
  const duration = value => typeof value === 'number' && Number.isFinite(value) ? `${(value / 1000).toFixed(2)} 秒` : '未返回';
  const number = value => typeof value === 'number' && Number.isFinite(value) ? String(value) : '未返回';
  function runCard(run, epoch) {
    const card = element('article', 'story-run');
    const status = { succeeded: '已保存', generating: '处理中 / 未确认（长期停留需人工核查）', needs_review: '失败或结果不确定，需人工核查' };
    card.append(element('h3', '', `${timestamp(run.created_at_ms)} · ${status[run.status] || run.status}`));
    const cost = run.cost, price = cost?.pricing;
    card.append(metadata([
      ['模型', run.model], ['故事版本', run.story_version], ['摘要版本', run.analysis_version],
      ['日期口径', `${run.story_date} · ${run.timezone} · ${run.date_basis}`], ['批次ID', run.run_id],
      ['供应商请求ID', run.provider_request_id], ['输入快照时刻', run.snapshot_at],
      ['整日已结束', run.day_complete == null ? '未知' : run.day_complete ? '是' : '否，仅为当时快照'],
      ['故事数量', number(run.story_count)], ['生成处理耗时（落库前）', duration(run.request_duration_ms)],
      ['模型耗时', duration(run.model_timings?.total_ms)], ['输入 tokens', number(run.usage?.prompt_tokens)],
      ['输出 tokens', number(run.usage?.completion_tokens)], ['总 tokens', number(run.usage?.total_tokens)],
      ['缓存输入 tokens', number(run.usage?.cached_input_tokens)], ['推理 tokens', number(run.usage?.reasoning_tokens)],
      ['费用估算', cost?.estimated_usd == null ? '未知（非零费用）' : `${cost.currency} ${cost.estimated_usd} · 估算，非实际账单`],
      ['输入 / 输出单价', price ? `${cost.currency} ${price.input} / ${price.output} 每百万 tokens` : '未知'],
      ['缓存输入单价', price?.cached_input == null ? '未知' : `${cost.currency} ${price.cached_input} 每百万 tokens`],
      ['计价核对日期', price?.verified_at], ['计价来源', price?.source], ['估算依据', cost?.basis],
      ['费用说明', cost?.note], ['错误码', run.error_code ?? '无'],
    ]));
    if (run.daily_summary) card.append(element('p', 'story-text', run.daily_summary));
    const button = element('button', 'secondary', '查看故事与四格提示词'); button.type = 'button';
    const content = element('div', 'story-content');
    content.id = `story-content-${run.run_id}`;
    content.hidden = true;
    button.setAttribute('aria-controls', content.id);
    button.setAttribute('aria-expanded', 'false');
    let loaded = false;
    if (run.status === 'succeeded') card.append(button, content);
    button.addEventListener('click', async () => {
      if (loaded) {
        content.hidden = !content.hidden;
        button.setAttribute('aria-expanded', String(!content.hidden));
        button.textContent = content.hidden ? '展开故事列表' : '收起故事列表';
        return;
      }
      button.disabled = true;
      try {
        const query = new URLSearchParams({ user: state.user.user_id, run_id: run.run_id });
        const data = await json(`/api/story?${query}`, { signal: state.controller.signal });
        if (epoch !== state.epoch) return;
        content.replaceChildren();
        const result = data.result;
        if (!result) throw new Error('missing_result');
        for (const story of result.stories) {
          const section = element('details', 'saved-story');
          const heading = element('summary', 'story-toggle');
          heading.append(element('span', 'story-title', story.title), element('span', 'story-toggle-hint'));
          const body = element('div', 'saved-story-body');
          section.append(heading, body);
          body.append(metadata([['故事ID', story.story_id], ['来源照片', story.source_photo_ids.join('、')]]),
            element('p', 'story-text', story.summary), element('h5', '', '整图生图提示词'), element('p', 'story-text', story.image_prompt));
          const panels = element('div', 'story-panels');
          for (const panel of story.panels) {
            const part = element('section', 'story-panel-item');
            part.append(element('h5', '', `第 ${panel.panel} 格`), element('p', 'story-text', panel.description),
              element('p', 'story-text', panel.image_prompt), element('p', 'muted story-text', `来源：${panel.source_photo_ids.join('、')}`));
            panels.append(part);
          }
          body.append(panels); content.append(section);
        }
        loaded = true; content.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        button.textContent = '收起故事列表';
      } catch (error) { fail(error, epoch); if (epoch === state.epoch) button.textContent = '重试加载故事详情'; }
      finally { if (epoch === state.epoch) button.disabled = false; }
    });
    return card;
  }
  async function loadStories(more = false) {
    if (state.loading || !state.user || !state.range || state.view !== 'stories') return;
    const epoch = state.epoch;
    const controller = state.controller ??= new AbortController();
    state.loading = true; ui['more-stories'].disabled = true; ui['retry-stories'].hidden = true;
    notice('加载历史故事…');
    try {
      const query = new URLSearchParams({ user: state.user.user_id, date: state.range.date });
      if (more && state.storyCursor) query.set('cursor', state.storyCursor);
      const data = await json(`/api/stories?${query}`, { signal: controller.signal });
      if (epoch !== state.epoch) return;
      if (!more) { ui['story-list'].replaceChildren(); state.storyCount = 0; }
      for (const run of data.runs) ui['story-list'].append(runCard(run, epoch));
      state.storyCount += data.runs.length; state.storyCursor = data.next_cursor;
      ui['more-stories'].hidden = !state.storyCursor;
      ui['story-status'].textContent = state.storyCount ? `已加载 ${state.storyCount} 个生成批次 · 只读，不触发模型` : '该上传日期暂无已登记故事；过去仅保存在本地的结果不会自动导入。';
      notice();
    } catch (error) { fail(error, epoch); if (epoch === state.epoch) { ui['retry-stories'].hidden = false; ui['retry-stories'].dataset.more = String(more); } }
    finally { if (epoch === state.epoch) { state.loading = false; ui['more-stories'].disabled = false; } }
  }
  function photoPath(photo) {
    return `/photo/${encodeURIComponent(photo.photo_id)}?user=${encodeURIComponent(state.user.user_id)}`;
  }
  async function loadImage(media) {
    if (state.images.has(media) || state.view !== 'photos' || !ui['photo-grid'].contains(media)) return;
    const epoch = state.epoch;
    const photo = state.photos[Number(media.dataset.index)];
    const img = element('img');
    img.alt = `${timestamp(photo.captured_at_ms)} 拍摄的照片`;
    img.decoding = 'async';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', `${img.alt}，查看大图`);
    img.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openLightbox(photo); }
    });
    const entry = { controller: new AbortController(), img, url: null };
    state.images.set(media, entry);
    media.querySelector('button').hidden = true;
    media.querySelector('span').textContent = '加载中…';
    try {
      const result = await response(photoPath(photo), { signal: entry.controller.signal });
      const blob = await result.blob();
      if (epoch !== state.epoch || state.images.get(media) !== entry) return;
      entry.url = URL.createObjectURL(blob);
      img.src = entry.url;
      img.addEventListener('error', () => {
        img.remove();
        media.querySelector('span').textContent = '图片解码失败';
        media.querySelector('button').hidden = false;
      }, { once: true });
      img.addEventListener('click', () => openLightbox(photo));
      media.querySelector('span').textContent = '';
      media.append(img);
    } catch (error) {
      if (epoch !== state.epoch || state.images.get(media) !== entry || error.name === 'AbortError') return;
      if (error.status === 401) { showLogin(errors.unauthorized); return; }
      media.querySelector('span').textContent = error.status === 404 ? '照片不存在' : message(error);
      media.querySelector('button').hidden = false;
    }
  }
  const imageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) loadImage(entry.target);
      else unloadImage(entry.target);
    }
  }, { rootMargin: '300px 0px', threshold: 0 });

  function card(photo, index) {
    const figure = element('figure', 'photo-card');
    const heading = element('div', 'photo-time', timeFormat.format(photo.captured_at_ms));
    heading.title = timestamp(photo.captured_at_ms);
    heading.append(element('span', '', `${photo.width} × ${photo.height}`));
    figure.append(heading);
    const media = element('div', 'photo-media');
    media.dataset.index = String(index);
    const retry = element('button', 'image-retry secondary', '重试');
    retry.type = 'button';
    retry.hidden = true;
    retry.addEventListener('click', () => { unloadImage(media); loadImage(media); });
    media.append(element('span'), retry);
    const caption = element('figcaption');
    const label = element('div', 'summary-label');
    const status = element('span', `badge${photo.analysis_status === 'succeeded' ? ' success' : ''}`, photo.analysis_status || '未分析');
    status.title = photo.analysis_status || '未分析';
    label.append(element('span', '', photo.analysis_version || '—'), status);
    const details = element('button', 'photo-details-button secondary', '详情');
    details.type = 'button';
    details.setAttribute('aria-label', `${photo.photo_id} 的详情`);
    details.addEventListener('click', () => openInfo(photo));
    caption.append(label, element('p', 'summary', photo.result_text || '—'), details);
    figure.append(media, caption);
    return figure;
  }
  function openInfo(photo) {
    ui['info-summary'].textContent = photo.result_text || '—';
    const metadata = [['照片 ID', photo.photo_id], ['拍摄时间', timestamp(photo.captured_at_ms)],
      ['时间来源', photo.captured_at_source || '—'], ['上传时间', timestamp(photo.uploaded_at_ms)],
      ['尺寸', `${photo.width} × ${photo.height}`], ['字节数', photo.byte_size], ['来源', photo.source],
      ['分析版本', photo.analysis_version || '—'], ['状态', photo.analysis_status || '未分析'], ['模型', photo.model || '—']];
    ui['info-metadata'].replaceChildren(...metadata.flatMap(([key, value]) => [element('dt', '', key), element('dd', '', value)]));
    ui['info-dialog'].showModal();
  }
  async function openLightbox(photo) {
    clearLightbox();
    const epoch = state.epoch;
    const entry = { controller: new AbortController(), url: null };
    state.lightbox = entry;
    ui['large-caption'].textContent = '加载中…';
    if (!ui.lightbox.open) ui.lightbox.showModal();
    try {
      const result = await response(photoPath(photo), { signal: entry.controller.signal });
      const blob = await result.blob();
      if (epoch !== state.epoch || state.lightbox !== entry) return;
      entry.url = URL.createObjectURL(blob);
      ui['large-photo'].src = entry.url;
      ui['large-caption'].textContent = `${timestamp(photo.captured_at_ms)} · ${photo.width} × ${photo.height}`;
    } catch (error) {
      if (epoch !== state.epoch || state.lightbox !== entry || error.name === 'AbortError') return;
      if (error.status === 401) showLogin(errors.unauthorized);
      else ui['large-caption'].textContent = message(error);
    }
  }
  function shiftDate(days) {
    if (!ui.date.reportValidity()) return;
    const date = new Date(`${ui.date.value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    const value = date.toISOString().slice(0, 10);
    if (value < ui.date.min || value > ui.date.max) return;
    ui.date.value = value;
    applyFilters();
  }
  function applySidebar(collapsed) {
    ui.workspace.classList.toggle('sidebar-collapsed', collapsed);
    ui['toggle-sidebar'].setAttribute('aria-expanded', String(!collapsed));
    ui['toggle-sidebar'].setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    ui['toggle-sidebar'].textContent = collapsed ? '›' : '‹';
  }
  let collapsed = false;
  try { collapsed = localStorage.getItem('lookme-sidebar-collapsed') === 'true'; } catch {}
  applySidebar(collapsed);
  ui['toggle-sidebar'].addEventListener('click', () => {
    collapsed = !collapsed;
    applySidebar(collapsed);
    try { localStorage.setItem('lookme-sidebar-collapsed', String(collapsed)); } catch {}
  });
  ui['login-form'].addEventListener('submit', async event => {
    event.preventDefault();
    ui['login-button'].disabled = true;
    ui['login-error'].textContent = '';
    const password = ui.password.value;
    ui.password.value = '';
    try {
      await json('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }) });
      await loadUsers();
    } catch (error) {
      ui['login-error'].textContent = error.status === 401 ? '口令错误。' : message(error);
      ui.password.focus();
    } finally { ui['login-button'].disabled = false; }
  });
  ui['more-stories'].addEventListener('click', () => loadStories(true));
  ui['retry-stories'].addEventListener('click', () => loadStories(ui['retry-stories'].dataset.more === 'true'));
  ui.refresh.addEventListener('click', () => loadUsers());
  ui.filters.addEventListener('submit', event => { event.preventDefault(); applyFilters(); });
  for (const id of ['start-time', 'end-time']) ui[id].addEventListener('input', () => ui['end-time'].setCustomValidity(''));
  ui['previous-day'].addEventListener('click', () => shiftDate(-1));
  ui['next-day'].addEventListener('click', () => shiftDate(1));
  ui['full-day'].addEventListener('click', () => {
    ui['start-time'].value = '00:00';
    ui['end-time'].value = '23:59';
    applyFilters();
  });
  ui['previous-page'].addEventListener('click', () => loadPage(state.pageIndex - 1));
  ui['next-page'].addEventListener('click', () => loadPage(state.pageIndex + 1));
  ui['retry-page'].addEventListener('click', () => loadPage(state.pageIndex));
  ui['close-lightbox'].addEventListener('click', () => ui.lightbox.close());
  ui.lightbox.addEventListener('close', clearLightbox);
  ui['close-info'].addEventListener('click', () => ui['info-dialog'].close());
  ui['info-dialog'].addEventListener('close', clearInfo);
  ui.date.value = dateValue(Date.now());
  updateView();
  ui['login-button'].disabled = true;
  loadUsers(true).finally(() => { ui['login-button'].disabled = false; });
})();
