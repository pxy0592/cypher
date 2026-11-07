const state = {
  apps: [],
  currentId: null,
  detail: null,
  busy: false,
  pollTimer: null,
  editors: { compose: null, env: null },
};

const $ = (sel) => document.querySelector(sel);

/* -------------------------------------------------------------------- api */

const TOKEN_KEY = 'cypher.token';

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, 'x-cypher-token': token } : extra;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: authHeaders({
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    }),
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { error: text }; }
  }
  if (res.status === 401) {
    await requestToken();
    throw new Error('已更新访问令牌，请重试');
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.detail = data.detail;
    err.status = res.status;
    throw err;
  }
  return data;
}

/**
 * Build a throwaway <dialog> for one interaction. Chained confirmations
 * (rename → confirm move) need independent dialogs: reusing a single element
 * lets the previous dialog's `close` event resolve the next one.
 */
function mountDialog(html) {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = html;
  document.body.append(dialog);
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal();
  const first = dialog.querySelector('input, textarea, button');
  if (first) setTimeout(() => first.focus(), 30);
  return dialog;
}

/** Ask for the server access token and keep it for this browser. */
function requestToken() {
  return new Promise((resolve) => {
    const dialog = mountDialog(`
      <form method="dialog" class="modal-body">
        <h3>需要访问令牌</h3>
        <div class="sub">服务端设置了 CYPHER_TOKEN，请输入令牌后继续。</div>
        <label>访问令牌
          <input name="token" type="password" autocomplete="current-password" required>
        </label>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">进入</button>
        </div>
      </form>
    `);
    const form = dialog.querySelector('form');
    let settled = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = new FormData(form).get('token') || '';
      try { localStorage.setItem(TOKEN_KEY, String(value).trim()); } catch { /* ignore */ }
      settled = true;
      dialog.close();
      resolve();
    });
    dialog.addEventListener('close', () => { if (!settled) resolve(); }, { once: true });
  });
}

/* ------------------------------------------------------------------ toast */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, kind === 'err' ? 6500 : 3200);
}

/* ------------------------------------------------------------ formatting */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function appHealth(containers) {
  if (!containers.length) return { label: '未部署', cls: 'stopped' };
  const running = containers.filter((c) => c.state === 'running').length;
  if (running === containers.length) return { label: `${running} 运行中`, cls: 'running' };
  if (running === 0) {
    const failed = containers.some((c) => c.exitCode > 0);
    return { label: failed ? '异常退出' : '已停止', cls: failed ? 'error' : 'stopped' };
  }
  return { label: `${running}/${containers.length} 运行`, cls: 'partial' };
}

/* ------------------------------------------------------------- app list */

async function loadApps() {
  try {
    const { apps } = await api('/api/apps');
    state.apps = apps;
    renderAppList();
  } catch (err) {
    if (err.status !== 401 && !String(err.message).includes('令牌')) {
      toast(err.message, 'err');
    }
    throw err;
  }
}

function renderAppList() {
  const nav = $('#app-list');
  if (!state.apps.length) {
    nav.innerHTML = '<div class="empty-hint">还没有应用，点击上方按钮新建。</div>';
    return;
  }
  nav.innerHTML = state.apps.map((app) => {
    const health = app.healthCache;
    const badge = health
      ? `<span class="pill ${health.cls}">${esc(health.label)}</span>`
      : '<span class="pill stopped">—</span>';
    return `<button class="app-item${app.id === state.currentId ? ' active' : ''}" data-id="${esc(app.id)}">
      <span class="name">${esc(app.name)}</span>
      ${badge}
    </button>`;
  }).join('');

  nav.querySelectorAll('.app-item').forEach((btn) => {
    btn.addEventListener('click', () => selectApp(btn.dataset.id));
  });
}

/** Update one badge in place so polling never re-creates the list. */
function updateListBadge(id, containers) {
  const app = state.apps.find((a) => a.id === id);
  if (!app) return;
  app.healthCache = appHealth(containers);
  const btn = document.querySelector(`.app-item[data-id="${CSS.escape(id)}"]`);
  if (!btn) {
    renderAppList();
    return;
  }
  const health = app.healthCache;
  let pill = btn.querySelector('.pill');
  if (!pill) {
    pill = document.createElement('span');
    btn.append(pill);
  }
  pill.className = `pill ${health.cls}`;
  pill.textContent = health.label;
  pill.style.opacity = '';
}

/* ----------------------------------------------------------- main render */

async function selectApp(id) {
  state.currentId = id;
  state.editors.compose = null;
  state.editors.env = null;
  renderAppList();
  await loadDetail();
  startPolling();
}

async function loadDetail({ silent = false, rerender = false } = {}) {
  const id = state.currentId;
  if (!id) return;
  try {
    const detail = await api(`/api/apps/${encodeURIComponent(id)}`);
    if (state.currentId !== id) return;
    const isFirst = rerender || !state.detail || state.detail.app.id !== id;
    state.detail = detail;
    updateListBadge(id, detail.containers);
    if (isFirst) {
      renderApp();
    } else {
      renderStatusSection();
    }
  } catch (err) {
    if (!silent) {
      toast(err.message, 'err');
      if (err.status === 404) {
        state.currentId = null;
        state.detail = null;
        $('#main').innerHTML = '<div class="placeholder"><h2>应用不存在</h2></div>';
        loadApps();
      }
    }
  }
}

function renderApp() {
  const detail = state.detail;
  if (!detail) return;
  const { app } = detail;
  const health = appHealth(detail.containers);

  $('#main').innerHTML = `
    <header class="app-head">
      <div>
        <h1><span id="app-title">${esc(app.name)}</span> <span class="pill ${health.cls}" id="head-pill">${esc(health.label)}</span></h1>
        <div class="meta" id="app-meta">${esc(app.id)} · ${esc(app.composeFile || '无 compose 文件')} · 更新于 ${relativeTime(app.updatedAt)}</div>
        <div class="meta path-line">
          <span>部署路径</span>
          <code id="app-path">${esc(app.deployPath)}</code>
        </div>
        <div id="path-warn"${app.missing ? '' : ' hidden'}>部署目录不存在，请检查路径或重新指定。</div>
      </div>
      <div class="spacer"></div>
      <div class="app-actions">
        <button class="btn btn-primary" data-action="up">启动</button>
        <button class="btn" data-action="restart">重启</button>
        <button class="btn" data-action="stop">停止</button>
        <button class="btn" data-action="down">移除容器</button>
        <button class="btn btn-ghost" id="btn-edit-meta">编辑信息</button>
        <button class="btn btn-danger" id="btn-delete">删除</button>
      </div>
    </header>

    <section class="card">
      <div class="card-head">
        <h3>容器状态</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" id="btn-refresh">刷新</button>
        <button class="btn btn-sm btn-ghost" id="btn-logs">查看日志</button>
      </div>
      <div class="card-body tight" id="status-section"></div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>Compose 配置</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" data-action="pull">拉取镜像</button>
        <button class="btn btn-sm btn-ghost" data-action="build">构建镜像</button>
        <button class="btn btn-sm" data-save="compose">保存并校验</button>
      </div>
      <div class="editor-wrap">
        <div class="editor-toolbar">
          <code>${esc(app.composeFile || 'docker-compose.yml')}</code>
          <div class="spacer"></div>
          <span id="compose-state">未修改</span>
        </div>
        <textarea class="code" id="editor-compose" spellcheck="false"></textarea>
      </div>
      <div class="hint">保存时会用 <code>docker compose config</code> 校验语法，校验不通过则保留原文件。</div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>环境变量 .env</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-save="env">保存</button>
      </div>
      <div class="editor-wrap">
        <div class="editor-toolbar">
          <code>.env</code>
          <div class="spacer"></div>
          <span id="env-state">未修改</span>
        </div>
        <textarea class="code" id="editor-env" spellcheck="false" placeholder="KEY=VALUE"></textarea>
      </div>
      <div class="hint">每行一个 <code>KEY=VALUE</code>，Compose 启动时会自动注入。没有引号的值不要包含空格。</div>
    </section>

    <section class="card">
      <div class="card-head"><h3>导入镜像</h3></div>
      <div class="card-body">
        <div class="dropzone" id="dropzone">
          <strong>拖入或点击选择镜像归档</strong>
          <span>支持 <code>docker save</code> 生成的 .tar / .tar.gz，导入后即可被 compose 引用</span>
          <div class="progress hidden" id="upload-progress"><div></div></div>
        </div>
      </div>
    </section>

    <section class="card" id="output-card" hidden>
      <div class="card-head">
        <h3>输出</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" id="btn-clear-output">清空</button>
      </div>
      <pre class="console" id="output"></pre>
    </section>

    <section class="card" id="logs-card" hidden>
      <div class="card-head">
        <h3>日志</h3>
        <div class="spacer"></div>
        <button class="btn btn-sm btn-ghost" id="btn-close-logs">关闭</button>
      </div>
      <pre class="console" id="logs"></pre>
    </section>
  `;

  renderStatusSection();
  bindAppEvents();
  loadFiles();
}

function renderStatusSection() {
  const detail = state.detail;
  const box = $('#status-section');
  if (!detail || !box) return;

  const health = appHealth(detail.containers);
  const pill = $('#head-pill');
  if (pill) {
    pill.className = `pill ${health.cls}`;
    pill.textContent = health.label;
  }

  const warn = $('#path-warn');
  if (warn) {
    warn.classList.toggle('warn', detail.app.missing);
    warn.hidden = !detail.app.missing;
  }

  if (detail.app.missing) {
    box.innerHTML = `<div class="hint" style="padding:18px 16px">
      部署目录已不存在，容器状态无法读取。请在「编辑信息」中修改部署路径。
    </div>`;
    return;
  }

  if (!detail.containers.length) {
    box.innerHTML = `<div class="hint" style="padding:18px 16px">
      还没有容器。编辑下方 Compose 文件后点击「启动」创建并运行容器。
    </div>`;
    return;
  }

  const rows = detail.containers.map((c) => {
    const stateLabel = c.state === 'running'
      ? (c.health === 'healthy' ? '运行中 · 健康' : c.health === 'unhealthy' ? '运行中 · 不健康' : '运行中')
      : c.state === 'exited' ? `已退出${c.exitCode ? ` (${c.exitCode})` : ''}` : (c.state || '未知');
    const dotCls = c.state === 'running'
      ? (c.health === 'unhealthy' ? 'bad' : 'ok')
      : 'bad';
    const links = c.links.length
      ? `<div class="port-links">${c.links.map((l) =>
          `<a href="${esc(l.url)}" target="_blank" rel="noopener">:${l.published}→${l.target}</a>`).join('')}</div>`
      : `<span class="muted">—</span>`;
    return `<tr>
      <td class="svc">${esc(c.service)}</td>
      <td><span class="state"><span class="dot ${dotCls}"></span>${esc(stateLabel)}</span></td>
      <td class="img">${esc(c.image)}</td>
      <td>${links}</td>
      <td class="cid">${esc(c.name)}<br><span class="muted">${esc(c.id.slice(0, 12))}</span></td>
    </tr>`;
  }).join('');

  box.innerHTML = `<table class="containers">
    <thead><tr><th>服务</th><th>状态</th><th>镜像</th><th>端口</th><th>容器</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ---------------------------------------------------------------- files */

async function loadFiles() {
  const id = state.currentId;
  try {
    const [compose, env] = await Promise.all([
      api(`/api/apps/${id}/files/compose`),
      api(`/api/apps/${id}/files/env`),
    ]);
    if (state.currentId !== id) return;
    const composeEl = $('#editor-compose');
    const envEl = $('#editor-env');
    if (!composeEl || !envEl) return;
    composeEl.value = compose.content;
    envEl.value = env.content;
    state.editors.compose = compose.content;
    state.editors.env = env.content;
    bindDirtyTracking();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function bindDirtyTracking() {
  [['compose', '#editor-compose', '#compose-state'], ['env', '#editor-env', '#env-state']]
    .forEach(([key, editorSel, labelSel]) => {
      const editor = $(editorSel);
      const label = $(labelSel);
      if (!editor || !label) return;
      editor.addEventListener('input', () => {
        const dirty = editor.value !== state.editors[key];
        label.textContent = dirty ? '未保存' : '未修改';
        label.style.color = dirty ? 'var(--amber)' : '';
      });
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const { selectionStart: s, selectionEnd: epos, value } = editor;
          editor.value = `${value.slice(0, s)}  ${value.slice(epos)}`;
          editor.selectionStart = editor.selectionEnd = s + 2;
          editor.dispatchEvent(new Event('input'));
        }
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          saveFile(key);
        }
      });
    });
}

async function saveFile(key) {
  const id = state.currentId;
  const editor = key === 'compose' ? $('#editor-compose') : $('#editor-env');
  const label = key === 'compose' ? $('#compose-state') : $('#env-state');
  if (!editor) return;
  try {
    await api(`/api/apps/${id}/files/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ content: editor.value }),
    });
    state.editors[key] = editor.value;
    if (label) { label.textContent = '已保存'; label.style.color = 'var(--green)'; }
    toast(key === 'compose' ? 'Compose 文件已保存并通过校验' : '.env 已保存', 'ok');
  } catch (err) {
    if (label) { label.textContent = '保存失败'; label.style.color = 'var(--red)'; }
    toast(err.message, 'err');
  }
}

/* --------------------------------------------------------------- actions */

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('[data-action], #btn-delete, [data-save]').forEach((btn) => {
    btn.disabled = busy;
  });
}

async function runAction(action) {
  if (state.busy) return;
  const id = state.currentId;
  const labels = {
    up: '正在启动…', down: '正在移除容器…', stop: '正在停止…',
    restart: '正在重启…', build: '正在构建镜像…', pull: '正在拉取镜像…',
  };
  setBusy(true);
  showOutput(`${labels[action] || '执行中…'}\n`);
  try {
    const result = await api(`/api/apps/${encodeURIComponent(id)}/actions/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    appendOutput(result.output || '(无输出)', 'ok');
    toast(`操作完成：${action}`, 'ok');
    if (state.detail) {
      state.detail.containers = result.containers;
      renderStatusSection();
      updateListBadge(id, result.containers);
    }
  } catch (err) {
    appendOutput(err.message, 'err');
    toast(err.message.split('\n')[0], 'err');
    loadDetail({ silent: true });
  } finally {
    setBusy(false);
  }
}

function showOutput(text) {
  const card = $('#output-card');
  const out = $('#output');
  if (!card || !out) return;
  card.hidden = false;
  out.textContent = text;
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function appendOutput(text, kind = '') {
  const card = $('#output-card');
  const out = $('#output');
  if (!card || !out) return;
  card.hidden = false;
  const span = document.createElement('span');
  if (kind) span.className = kind;
  span.textContent = text ? `${text}\n` : '';
  out.append(span);
  out.scrollTop = out.scrollHeight;
}

async function showLogs() {
  const id = state.currentId;
  const card = $('#logs-card');
  const pre = $('#logs');
  if (!card || !pre) return;
  card.hidden = false;
  pre.textContent = '加载中…';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const { logs } = await api(`/api/apps/${id}/logs?tail=300`);
    if (state.currentId !== id) return;
    pre.textContent = logs || '(无日志)';
    pre.scrollTop = pre.scrollHeight;
  } catch (err) {
    pre.textContent = err.message;
  }
}

/* ---------------------------------------------------------------- upload */

function bindUpload() {
  const zone = $('#dropzone');
  if (!zone) return;
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.tar,.gz,.tgz,.zst';
  picker.style.display = 'none';
  zone.after(picker);

  zone.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    if (picker.files[0]) uploadImage(picker.files[0]);
    picker.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('over');
    });
  });
  zone.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) uploadImage(file);
  });
}

function uploadImage(file) {
  const id = state.currentId;
  const progress = $('#upload-progress');
  const bar = progress?.querySelector('div');
  const zone = $('#dropzone');
  if (progress) progress.classList.remove('hidden');
  if (bar) bar.style.width = '0%';
  zone.style.pointerEvents = 'none';
  zone.style.opacity = '.7';

  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/apps/${encodeURIComponent(id)}/images?filename=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('content-type', 'application/octet-stream');
  const token = getToken();
  if (token) xhr.setRequestHeader('x-cypher-token', token);

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable && bar) {
      bar.style.width = `${Math.round((e.loaded / e.total) * 90)}%`;
    }
  });

  xhr.addEventListener('load', () => {
    zone.style.pointerEvents = '';
    zone.style.opacity = '';
    if (bar) bar.style.width = '100%';
    let payload = {};
    try { payload = JSON.parse(xhr.responseText); } catch { /* ignore */ }
    if (xhr.status === 401) {
      progress?.classList.add('hidden');
      requestToken().then(() => toast('已更新令牌，请重新选择文件', 'ok'));
      return;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      appendOutput(`$ docker load < ${file.name}\n${payload.output || ''}`);
      const names = payload.names?.length ? payload.names.join(', ') : payload.images?.join(', ') || '镜像';
      toast(`导入完成：${names}`, 'ok');
      setTimeout(() => progress?.classList.add('hidden'), 900);
    } else {
      appendOutput(payload.error || `导入失败 (${xhr.status})`, 'err');
      toast(payload.error || '镜像导入失败', 'err');
      progress?.classList.add('hidden');
    }
  });

  xhr.addEventListener('error', () => {
    zone.style.pointerEvents = '';
    zone.style.opacity = '';
    progress?.classList.add('hidden');
    toast('上传失败，请检查网络连接', 'err');
  });

  xhr.send(file);
}

/* ----------------------------------------------------------------- modal */

function openModal({ title, subtitle, fields, confirmText = '确定', danger = false }) {
  const fieldHtml = fields.map((f) => `
    <label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}
      ${f.type === 'textarea'
        ? `<textarea name="${esc(f.name)}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
        : `<input name="${esc(f.name)}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''} maxlength="${f.maxlength || 200}">`}
    </label>`).join('');

  const dialog = mountDialog(`
    <form method="dialog" class="modal-body">
      <h3>${esc(title)}</h3>
      ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
      ${fieldHtml}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-cancel>取消</button>
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmText)}</button>
      </div>
    </form>
  `);

  const form = dialog.querySelector('form');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();   // the close handler removes the element
    };

    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(Object.fromEntries(new FormData(form).entries()));
    });
    dialog.addEventListener('close', () => finish(null), { once: true });
  });
}

/* ---------------------------------------------------------------- events */

function bindAppEvents() {
  document.querySelectorAll('.app-actions [data-action]').forEach((btn) => {
    btn.addEventListener('click', () => runAction(btn.dataset.action));
  });

  document.querySelectorAll('.card-head [data-action]').forEach((btn) => {
    btn.addEventListener('click', () => runAction(btn.dataset.action));
  });

  document.querySelectorAll('[data-save]').forEach((btn) => {
    btn.addEventListener('click', () => saveFile(btn.dataset.save));
  });

  $('#btn-refresh')?.addEventListener('click', () => loadDetail());
  $('#btn-logs')?.addEventListener('click', showLogs);
  $('#btn-close-logs')?.addEventListener('click', () => { $('#logs-card').hidden = true; });
  $('#btn-clear-output')?.addEventListener('click', () => { $('#output-card').hidden = true; });

  $('#btn-edit-meta')?.addEventListener('click', async () => {
    const app = state.detail.app;
    const result = await openModal({
      title: '编辑应用信息',
      subtitle: '修改部署路径会把整个目录迁移到新位置，容器会先被停止。',
      fields: [
        { name: 'name', label: '应用名称', value: app.name, required: true, maxlength: 64 },
        { name: 'description', label: '描述', value: app.description, type: 'textarea' },
        {
          name: 'deployPath', label: '部署路径',
          value: app.deployPath, maxlength: 500,
          placeholder: '/srv/apps/my-app',
        },
      ],
      confirmText: '保存',
    });
    if (!result) return;
    const pathChanged = result.deployPath.trim() !== app.deployPath;
    if (pathChanged) {
      const ok = await openModal({
        title: '确认迁移部署目录',
        subtitle: `${app.deployPath} → ${result.deployPath}`,
        fields: [{ name: 'ack', label: '输入 MOVE 确认迁移', required: true, maxlength: 8 }],
        confirmText: '迁移',
        danger: true,
      });
      if (!ok || ok.ack.trim().toUpperCase() !== 'MOVE') {
        toast('已取消迁移', 'err');
        return;
      }
    }
    try {
      const { app: updated } = await api(`/api/apps/${app.id}`, {
        method: 'PATCH',
        body: JSON.stringify(result),
      });
      toast(pathChanged ? '已迁移到新路径' : '已保存', 'ok');
      await loadApps();
      state.detail = null;
      await loadDetail({ rerender: true });
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#btn-delete')?.addEventListener('click', async () => {
    const app = state.detail.app;
    const pathNote = app.owned
      ? `默认目录 ${app.deployPath} 下的文件会一并删除。`
      : `自定义部署路径 ${app.deployPath} 仅从列表移除，文件保留。`;
    const result = await openModal({
      title: `删除应用「${app.name}」`,
      subtitle: `会停止并移除容器。${pathNote}`,
      fields: [{ name: 'confirm', label: `输入应用 ID「${app.id}」以确认`, required: true, maxlength: 64 }],
      confirmText: '删除',
      danger: true,
    });
    if (!result) return;
    if (result.confirm !== app.id) {
      toast('确认文本不匹配，已取消', 'err');
      return;
    }
    try {
      const res = await api(`/api/apps/${app.id}`, { method: 'DELETE' });
      toast(res.removedFiles ? '应用已删除，部署目录已清理' : '应用已删除，部署目录文件已保留', 'ok');
      state.currentId = null;
      state.detail = null;
      stopPolling();
      $('#main').innerHTML = '<div class="placeholder"><h2>选择一个应用</h2><p>从左侧选择应用，或新建一个 Compose 应用开始部署。</p></div>';
      await loadApps();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  bindUpload();
}

/* -------------------------------------------------------------- polling */

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!state.busy && state.currentId) loadDetail({ silent: true });
  }, 5000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* -------------------------------------------------------------- system */

async function showSystem() {
  try {
    const info = await api('/api/system');
    const dialog = mountDialog(`
      <div class="modal-body">
        <h3>运行环境</h3>
        <div class="sub">服务端 Docker 连接信息</div>
        <dl class="kv">
          <dt>Docker</dt><dd>${esc(info.dockerVersion || '不可用')}</dd>
          <dt>Compose</dt><dd>${esc(info.composeVersion || '不可用')}</dd>
          <dt>守护进程</dt><dd>${info.daemon ? '已连接' : '未连接'}</dd>
          <dt>数据目录</dt><dd>${esc(info.dataDir)}</dd>
          <dt>主机</dt><dd>${esc(info.host)}</dd>
        </dl>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" data-cancel>关闭</button>
        </div>
      </div>
    `);
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function checkDaemon() {
  const dot = $('#daemon-dot');
  try {
    const info = await api('/api/system');
    dot.className = `dot ${info.daemon && info.composeVersion ? 'ok' : 'bad'}`;
    dot.title = info.daemon
      ? `Docker ${info.dockerVersion} · Compose ${info.composeVersion}`
      : 'Docker 守护进程不可用';
  } catch {
    dot.className = 'dot bad';
    dot.title = '无法连接服务端';
  }
}

/* ------------------------------------------------------------------ init */

$('#btn-new-app').addEventListener('click', async () => {
  const result = await openModal({
    title: '新建应用',
    subtitle: '将创建一个独立目录，包含 Compose 文件与 .env 模板。留空则使用默认目录 data/apps/<id>。',
    fields: [
      { name: 'name', label: '应用名称', placeholder: '例如：博客系统', required: true, maxlength: 64 },
      {
        name: 'deployPath', label: '部署路径',
        placeholder: '/srv/apps/my-app 或 ~/apps/my-app（留空用默认目录）',
        maxlength: 500,
      },
      { name: 'description', label: '描述', placeholder: '可选', type: 'textarea' },
    ],
    confirmText: '创建',
  });
  if (!result) return;
  try {
    const { app } = await api('/api/apps', { method: 'POST', body: JSON.stringify(result) });
    toast(`已创建应用「${app.name}」`, 'ok');
    await loadApps();
    await selectApp(app.id);
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btn-system').addEventListener('click', showSystem);

await (async function boot() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await loadApps();
      break;
    } catch (err) {
      if (attempt === 0 && String(err.message).includes('令牌')) continue;
      break;
    }
  }
})();
await checkDaemon();
setInterval(checkDaemon, 30_000);
