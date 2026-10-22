/**
 * 创建分享页面。
 *
 * 三条路径：
 *   staged + file -> 逐个 PUT 上传（带进度），完成即可关页面
 *   staged + text -> 内容随创建请求入库，完成即可关页面
 *   p2p           -> 保持页面打开，等对方接入；文件优先 WebRTC，失败自动改内存中继
 */

import {
  apiJson, loadPublicConfig, saveLocalShare,
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
  share: null,
};

function shareUrl() {
  return state.share ? `${window.location.origin}/s/${state.share.id}` : '';
}

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
    // Drag Handle Illusion：悬停时左侧 ⋮⋮ 淡入（仅装饰，不进无障碍树）
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⋮⋮';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.relPath;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(item.size);
    li.append(handle, name, size);
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
    if (state.files.length === 0) return '请先选择要分享的文件。';
    const oversize = state.files.find((item) => item.size > state.config.maxFileBytes);
    if (oversize) return `「${oversize.name}」超过单文件上限 ${formatBytes(state.config.maxFileBytes)}`;
  } else {
    const text = $('text-input').value;
    if (text.trim() === '') return '请输入要分享的文字。';
    if (new TextEncoder().encode(text).length > state.config.maxTextBytes) {
      return `文字超过上限 ${formatBytes(state.config.maxTextBytes)}`;
    }
  }
  const maxDownloadsRaw = $('max-downloads').value.trim();
  if (maxDownloadsRaw !== '' && (!Number.isInteger(Number(maxDownloadsRaw)) || Number(maxDownloadsRaw) < 1)) {
    return '最多取走次数须为正整数，或留空。';
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
    // 结果区在表单下方，窄屏上主动带进视野（无动画，尊重 reduced-motion）
    $('result').scrollIntoView({ block: 'start' });
    $('result-title').focus({ preventScroll: true });

    if (created.mode === 'staged') {
      if (created.kind === 'file') await uploadStaged(created);
      else setSenderStatus('上传完成，可以关闭本页面了。', 'ok');
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

  const url = shareUrl();
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
  const url = shareUrl();
  $('share-url').textContent = url;
  $('open-url').href = url;
  const origin = encodeURIComponent(window.location.origin);
  $('qr-img').src = `/api/shares/${share.id}/qr.svg?origin=${origin}&t=${encodeURIComponent(share.ownerToken)}`;
}

function renderNextSteps(share) {
  const steps = $('next-steps');
  const items = [];

  items.push(share.password ? '请将链接与密码分开发送给对方。' : '请将链接发送给对方。');
  if (share.mode === 'p2p') {
    items.push('请保持本页面开启，关闭后链接即失效。');
  } else {
    items.push('当前可以关闭本页面。');
  }

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
      reject(new Error(data?.message ?? '上传失败，请稍后重试。'));
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
  setSenderStatus('正在上传…');

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
    setSenderStatus('上传完成，可以关闭本页面了。', 'ok');
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
          setSenderStatus('对方已连接，开始传输…', 'ok');
          maybeStart();
        }
      },
      onPeerLeft: () => {
        if (!finished) setSenderStatus('对方已离开，链接仍然有效。', 'warn');
      },
      onPayload: (payload) => {
        rtc?.handleSignal(payload).catch(() => {});
      },
      onClose: () => {
        if (!finished) setSenderStatus('连接已断开，请刷新页面重新等待。', 'danger');
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
    setSenderStatus('正在连接对方…');

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
        onFailed: () => rejectOnFailure(new Error('直接连接失败')),
      },
    });

    try {
      const offer = await rtc.createOffer();
      signaling.send({ k: 'sdp', sdp: offer });
      await Promise.race([rtc.waitForChannel(CHANNEL_TIMEOUT_MS), failure]);
      setSenderStatus('已连接对方，开始传输…', 'ok');

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
      setSenderStatus('无法直接连接，改为由服务器转交（不会保存到服务器）…', 'warn');
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
      setSenderStatus('全部文件已送达对方，可以关闭页面了。', 'ok');
    } catch (err) {
      setSenderStatus(`发送失败：${err.message}`, 'danger');
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

async function init() {
  state.config = await loadPublicConfig();
  $('app-name').textContent = state.config.appName;
  document.title = `${state.config.appName} · 分享文件与文字`;

  fillTtlOptions();
  updateQr();
  updateTextCount();

  $('tab-file').addEventListener('click', () => switchKind('file'));
  $('tab-text').addEventListener('click', () => switchKind('text'));
  $('file-input').addEventListener('change', (event) => collectFiles(event.target, false));
  $('dir-input').addEventListener('change', (event) => collectFiles(event.target, true));
  $('text-input').addEventListener('input', updateTextCount);
  $('create-btn').addEventListener('click', onCreate);

  $('copy-url').addEventListener('click', () => {
    navigator.clipboard?.writeText(shareUrl());
    setStatus('链接已复制', 'ok');
  });
  $('copy-password').addEventListener('click', () => {
    navigator.clipboard?.writeText($('share-password').textContent);
    setStatus('密码已复制', 'ok');
  });
}

init().catch(() => setStatus('页面加载失败，请刷新重试。', 'danger'));
