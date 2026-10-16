/**
 * 创建分享页面。
 *
 * 三条路径：
 *   staged + file -> 逐个 PUT 上传（带进度），完成即可关页面
 *   staged + text -> 内容随创建请求入库，完成即可关页面
 *   p2p           -> 保持页面打开，等对方接入；文件优先 WebRTC，失败自动改内存中继
 */

import {
  apiJson, loadNetworkCandidates, loadPublicConfig, saveLocalShare,
} from './api.js';
import { describeProgress, formatBytes } from './format.js';
import {
  CHANNEL_TIMEOUT_MS, PATH, RtcPeer, createSignaling, postViaRelay,
} from './transport.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  kind: 'file',
  files: [],
  origins: [],
  origin: '',
  share: null,
};

function setStatus(text, tone = '') {
  const el = $('create-status');
  el.className = `muted small ${tone}`;
  el.textContent = text;
}

function setSenderStatus(text, tone = '') {
  const el = $('sender-status');
  el.hidden = false;
  el.className = `notice ${tone}`;
  el.textContent = text;
}

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked')?.value ?? 'p2p';
}

// ---------------------------------------------------------------------------
// 选择文件
// ---------------------------------------------------------------------------

function collectFiles(input, fromDirectory) {
  const picked = [...(input.files ?? [])];
  if (picked.length === 0) return;

  state.files = picked.map((file) => ({
    file,
    relPath: (fromDirectory && file.webkitRelativePath) ? file.webkitRelativePath : file.name,
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
  }));

  $('file-input').value = '';
  $('dir-input').value = '';
  renderFiles();
}

function renderFiles() {
  const list = $('file-list');
  list.replaceChildren();

  let total = 0;
  for (const item of state.files) {
    total += item.size;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.relPath;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(item.size);
    li.append(name, size);
    list.append(li);
  }

  const summary = $('file-summary');
  if (state.files.length === 0) {
    summary.textContent = '';
    return;
  }
  summary.textContent = `已选 ${state.files.length} 个文件，合计 ${formatBytes(total)}`;

  const oversize = state.files.filter((item) => item.size > state.config.maxFileBytes);
  if (oversize.length > 0) {
    summary.textContent += `　⚠️ 有 ${oversize.length} 个文件超过单文件上限 ${formatBytes(state.config.maxFileBytes)}`;
    summary.className = 'muted small danger';
  } else {
    summary.className = 'muted small';
  }
}

function updateTextCount() {
  const bytes = new TextEncoder().encode($('text-input').value).length;
  const max = state.config.maxTextBytes;
  const el = $('text-count');
  el.textContent = `${formatBytes(bytes)} / ${formatBytes(max)}`;
  el.className = bytes > max ? 'muted small danger' : 'muted small';
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

function buildInput() {
  const mode = selectedMode();
  const ttlHours = Number($('ttl-select').value) || state.config.defaultTtlHours;
  const maxDownloadsRaw = $('max-downloads').value.trim();
  const common = {
    kind: state.kind,
    mode,
    ttlHours,
    password: $('password-toggle').checked,
    burnAfterRead: $('burn-toggle').checked,
    baseUrl: state.origin,
    ...(maxDownloadsRaw === '' ? {} : { maxDownloads: Number(maxDownloadsRaw) }),
  };

  if (state.kind === 'text') {
    return { ...common, text: $('text-input').value };
  }
  return {
    ...common,
    files: state.files.map((item) => ({
      relPath: item.relPath, name: item.name, size: item.size, mime: item.mime,
    })),
  };
}

function validate() {
  if (state.kind === 'file') {
    if (state.files.length === 0) return '请先选择要分享的文件';
    const oversize = state.files.find((item) => item.size > state.config.maxFileBytes);
    if (oversize) return `「${oversize.name}」超过单文件上限 ${formatBytes(state.config.maxFileBytes)}`;
  } else {
    const text = $('text-input').value;
    if (text.trim() === '') return '请先输入要分享的文字';
    if (new TextEncoder().encode(text).length > state.config.maxTextBytes) {
      return `文字超过上限 ${formatBytes(state.config.maxTextBytes)}`;
    }
  }
  const maxDownloadsRaw = $('max-downloads').value.trim();
  if (maxDownloadsRaw !== '' && (!Number.isInteger(Number(maxDownloadsRaw)) || Number(maxDownloadsRaw) < 1)) {
    return '最多取走次数要填正整数，或留空';
  }
  return null;
}

async function onCreate() {
  const problem = validate();
  if (problem) {
    setStatus(problem, 'danger');
    return;
  }

  const button = $('create-btn');
  button.disabled = true;
  setStatus('正在创建分享…');

  try {
    const created = await apiJson('/api/shares', { method: 'POST', body: buildInput() });
    state.share = created;

    saveLocalShare({
      id: created.id,
      kind: created.kind,
      mode: created.mode,
      title: created.title,
      url: created.url,
      password: created.password,
      ownerToken: created.ownerToken,
      requiresPassword: created.requiresPassword,
      createdAt: Date.now(),
      expiresAt: created.expiresAt,
      totalBytes: created.totalBytes,
      files: (created.files ?? []).map((item) => item.relPath),
    });

    renderResult(created);
    setStatus('分享已创建', 'ok');

    if (created.mode === 'staged') {
      if (created.kind === 'file') await uploadStaged(created);
      else setSenderStatus('文字已保存到服务器，可以关闭本页面了。', 'ok');
    } else {
      await startP2PSession(created);
    }
  } catch (err) {
    setStatus(err.message, 'danger');
  } finally {
    button.disabled = false;
  }
}

function renderResult(share) {
  $('result').hidden = false;

  const url = `${state.origin}/s/${share.id}`;
  $('share-url').textContent = url;
  $('open-url').href = url;

  const passwordWrap = $('password-wrap');
  if (share.password) {
    passwordWrap.hidden = false;
    $('share-password').textContent = share.password;
  } else {
    passwordWrap.hidden = true;
  }

  updateQr();
  renderNextSteps(share);
}

function updateQr() {
  const share = state.share;
  if (!share) return;
  const url = `${state.origin}/s/${share.id}`;
  $('share-url').textContent = url;
  $('open-url').href = url;
  $('qr-img').src = `/api/shares/${share.id}/qr.svg?origin=${encodeURIComponent(state.origin)}&t=${encodeURIComponent(share.ownerToken)}`;
}

function renderNextSteps(share) {
  const steps = $('next-steps');
  const items = [];

  if (share.mode === 'p2p') {
    items.push('把链接发给对方，并单独把密码告诉他。');
    items.push('保持本页面打开——你关掉页面，链接就失效了。');
    items.push('对方打开链接后会自动开始传输，进度会显示在这里。');
  } else {
    items.push('把链接发给对方，并单独把密码告诉他。');
    items.push(`文件保存在服务器上，${Math.round(share.ttlHours)} 小时后自动删除。`);
    items.push('现在就可以关闭本页面了。');
  }

  if (share.burnAfterRead) items.push('这是阅后即焚分享：被取走一次后立即销毁。');
  if (share.maxDownloads) items.push(`最多被取走 ${share.maxDownloads} 次，之后链接失效。`);

  steps.replaceChildren();
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    steps.append(li);
  }
}

// ---------------------------------------------------------------------------
// 暂存上传
// ---------------------------------------------------------------------------

function putStagedFile({ shareId, idx, token, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/shares/${shareId}/files/${idx}`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (event) => onProgress?.(event.loaded, event.total || file.size));
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        resolve(data);
        return;
      }
      reject(new Error(data?.message ?? `上传失败（HTTP ${xhr.status}）`));
    });
    xhr.addEventListener('error', () => reject(new Error('上传失败：网络错误')));
    xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
    xhr.send(file);
  });
}

async function uploadStaged(share) {
  const total = state.files.reduce((sum, item) => sum + item.size, 0);
  const progress = $('progress');
  const progressText = $('progress-text');
  progress.hidden = false;

  let uploaded = 0;
  const startedAt = Date.now();
  setSenderStatus('正在上传到服务器…');

  try {
    for (const [idx, item] of state.files.entries()) {
      await putStagedFile({
        shareId: share.id,
        idx,
        token: share.ownerToken,
        file: item.file,
        onProgress: (sent) => {
          const overall = uploaded + sent;
          progress.value = total > 0 ? (overall / total) * 100 : 100;
          progressText.textContent = describeProgress({ sent: overall, total, startedAt });
        },
      });
      uploaded += item.size;
      progress.value = total > 0 ? (uploaded / total) * 100 : 100;
    }
    progressText.textContent = `已上传 ${formatBytes(uploaded)}`;
    setSenderStatus('全部文件已保存到服务器，可以关闭本页面了。', 'ok');
  } catch (err) {
    setSenderStatus(`上传失败：${err.message}`, 'danger');
  }
}

// ---------------------------------------------------------------------------
// P2P 发送
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startP2PSession(share) {
  const isText = share.kind === 'text';
  let iceServers = [];
  try {
    const rtcConfig = await apiJson(`/api/rtc-config?share=${share.id}`, { token: share.ownerToken });
    iceServers = rtcConfig.iceServers ?? [];
  } catch {
    iceServers = [];
  }

  let rtc = null;
  let started = false;
  let finished = false;
  setSenderStatus('等待对方打开链接…');

  const signaling = createSignaling({
    shareId: share.id,
    role: 'sender',
    token: share.ownerToken,
    handlers: {
      onPeerJoined: (role) => {
        if (role === 'receiver' || role === 'download') {
          setSenderStatus('对方已接入，开始传输…', 'ok');
          maybeStart();
        }
      },
      onPeerLeft: () => {
        if (!finished) setSenderStatus('对方已离开。链接依然有效，等他再打开一次即可。', 'warn');
      },
      onPayload: (payload) => {
        rtc?.handleSignal(payload).catch(() => {});
      },
      onClose: () => {
        if (!finished) setSenderStatus('信令连接已断开，请刷新页面重新等待。', 'danger');
      },
    },
  });

  const readyState = await signaling.ready;
  if (readyState.peers.some((role) => role === 'receiver' || role === 'download')) {
    setSenderStatus('对方已在等待，开始传输…', 'ok');
    maybeStart();
  }

  async function maybeStart() {
    if (started) return;
    started = true;
    if (isText) {
      await sendTextViaRelay();
      return;
    }
    await sendFiles();
  }

  async function sendTextViaRelay() {
    signaling.send({ k: 'path', path: PATH.RELAY });
    setSenderStatus('正在把文字发给对方…');

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await postViaRelay({
          shareId: share.id,
          token: share.ownerToken,
          body: $('text-input').value,
          contentType: 'text/plain; charset=utf-8',
        });
        finished = true;
        setSenderStatus('文字已送达对方。', 'ok');
        return;
      } catch (err) {
        if (attempt === 3) {
          setSenderStatus(`发送失败：${err.message}`, 'danger');
          return;
        }
        await sleep(1500);
      }
    }
  }

  function attachRtcHandlers() {
    return {
      onCandidate: (candidate) => signaling.send({ k: 'candidate', candidate }),
      onData: () => {},
    };
  }

  async function sendFiles() {
    setSenderStatus('正在尝试浏览器直连（P2P）…');

    const progress = $('progress');
    const progressText = $('progress-text');
    progress.hidden = false;

    let rejectOnFailure;
    const failure = new Promise((_, reject) => {
      rejectOnFailure = reject;
    });

    rtc = new RtcPeer({
      iceServers,
      role: 'sender',
      handlers: {
        ...attachRtcHandlers(),
        onFailed: () => rejectOnFailure(new Error('直连失败')),
      },
    });

    try {
      const offer = await rtc.createOffer();
      signaling.send({ k: 'sdp', sdp: offer });
      await Promise.race([rtc.waitForChannel(CHANNEL_TIMEOUT_MS), failure]);
      setSenderStatus('已建立浏览器直连：文件不经过服务器。', 'ok');

      const total = state.files.reduce((sum, item) => sum + item.size, 0);
      const startedAt = Date.now();
      let sentBytes = 0;

      for (const item of state.files) {
        await rtc.sendFile(item.file, {
          idx: item.idx ?? state.files.indexOf(item),
          onProgress: (sent) => {
            const overall = sentBytes + sent;
            progress.value = total > 0 ? (overall / total) * 100 : 100;
            progressText.textContent = describeProgress({ sent: overall, total, startedAt });
          },
        });
        sentBytes += item.file.size;
      }

      finished = true;
      progressText.textContent = `已传送 ${formatBytes(sentBytes)}`;
      setSenderStatus('全部文件已送达对方，可以关闭页面了。', 'ok');
      return;
    } catch (err) {
      rtc.close();
      rtc = null;
      setSenderStatus(`直连不可用（${err.message}），改用服务器内存转发，文件依旧不落盘。`, 'warn');
    }

    signaling.send({ k: 'path', path: PATH.RELAY });
    await sleep(200);
    await sendFilesViaRelay(progress, progressText);
  }

  async function sendFilesViaRelay(progress, progressText) {
    const total = state.files.reduce((sum, item) => sum + item.size, 0);
    const startedAt = Date.now();
    let sentBytes = 0;

    try {
      for (const [idx, item] of state.files.entries()) {
        await postViaRelay({
          shareId: share.id,
          idx,
          token: share.ownerToken,
          body: item.file,
          onProgress: (sent) => {
            const overall = sentBytes + sent;
            progress.value = total > 0 ? (overall / total) * 100 : 100;
            progressText.textContent = describeProgress({ sent: overall, total, startedAt });
          },
        });
        sentBytes += item.file.size;
      }
      finished = true;
      progressText.textContent = `已传送 ${formatBytes(sentBytes)}`;
      setSenderStatus('全部文件已送达对方（经服务器内存转发，未写入磁盘），可以关闭页面了。', 'ok');
    } catch (err) {
      setSenderStatus(`转发失败：${err.message}`, 'danger');
    }
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function switchKind(kind) {
  state.kind = kind;
  $('tab-file').setAttribute('aria-selected', String(kind === 'file'));
  $('tab-text').setAttribute('aria-selected', String(kind === 'text'));
  $('file-panel').hidden = kind !== 'file';
  $('text-panel').hidden = kind !== 'text';
}

function fillTtlOptions() {
  const select = $('ttl-select');
  const max = state.config.maxTtlHours;
  const options = [1, 6, 24, 72, 168].filter((hours) => hours <= max);
  if (!options.includes(max)) options.push(max);
  options.sort((a, b) => a - b);

  select.replaceChildren();
  for (const hours of options) {
    const option = document.createElement('option');
    option.value = String(hours);
    option.textContent = hours < 24 ? `${hours} 小时` : `${hours / 24} 天（${hours} 小时）`;
    if (hours === state.config.defaultTtlHours) option.selected = true;
    select.append(option);
  }
}

function fillOrigins() {
  const select = $('origin-select');
  select.replaceChildren();

  const candidates = state.origins.length > 0
    ? state.origins
    : [{ url: window.location.origin, label: '当前访问的地址' }];

  state.origin = candidates[0].url;
  for (const candidate of candidates) {
    const option = document.createElement('option');
    option.value = candidate.url;
    option.textContent = `${candidate.url}（${candidate.label}）`;
    select.append(option);
  }
  select.value = state.origin;
}

async function init() {
  state.config = await loadPublicConfig();
  $('app-name').textContent = state.config.appName;
  document.title = `${state.config.appName} · 分享文件与文字`;

  fillTtlOptions();
  state.origins = await loadNetworkCandidates();
  fillOrigins();
  updateQr();
  updateTextCount();

  $('tab-file').addEventListener('click', () => switchKind('file'));
  $('tab-text').addEventListener('click', () => switchKind('text'));
  $('file-input').addEventListener('change', (event) => collectFiles(event.target, false));
  $('dir-input').addEventListener('change', (event) => collectFiles(event.target, true));
  $('text-input').addEventListener('input', updateTextCount);
  $('create-btn').addEventListener('click', onCreate);

  $('origin-select').addEventListener('change', (event) => {
    state.origin = event.target.value;
    updateQr();
  });

  $('copy-url').addEventListener('click', () => {
    navigator.clipboard?.writeText(`${state.origin}/s/${state.share?.id ?? ''}`);
    setStatus('链接已复制', 'ok');
  });
  $('copy-password').addEventListener('click', () => {
    navigator.clipboard?.writeText($('share-password').textContent);
    setStatus('密码已复制', 'ok');
  });
}

init().catch((err) => setStatus(`初始化失败：${err.message}`, 'danger'));
