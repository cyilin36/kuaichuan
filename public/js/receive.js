/**
 * 接收分享页面。
 *
 * 流程：/public 拿最小信息 -> 解锁拿 access token -> 拉元数据 -> 取件
 *   staged + file：逐个文件流式下载（有 FSA 就写进你选的目录）
 *   staged + text：取件接口返回文字（可能是一次性的）
 *   p2p          ：保持页面打开，等发送方；文件优先 WebRTC，失败自动改内存中继
 */

import { apiJson, getAccessToken, loadPublicConfig, saveAccessToken } from './api.js';
import { describeProgress, formatBytes, formatRemaining, describeKind, describeMode } from './format.js';
import {
  CHANNEL_TIMEOUT_MS, PATH, RtcPeer, createFileSystemSink, createMemorySink, createSignaling,
  readViaRelay, saveBlob, supportsDirectoryPicker,
} from './transport.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  shareId: '',
  publicInfo: null,
  share: null,
  token: null,
  directoryHandle: null,
  signaling: null,
  rtc: null,
  receiving: false,
  finished: false,
};

function setStatus(text, tone = '') {
  const el = $('status');
  el.className = `muted ${tone}`;
  el.textContent = text;
}

function notice(text, tone = '') {
  const el = document.createElement('div');
  el.className = `notice ${tone}`;
  el.textContent = text;
  $('notices').append(el);
}

function authHeaders() {
  return { authorization: `Bearer ${state.token}` };
}

// ---------------------------------------------------------------------------
// 基本信息与解锁
// ---------------------------------------------------------------------------

async function loadPublicInfo() {
  state.publicInfo = await apiJson(`/api/shares/${state.shareId}/public`);
  const info = state.publicInfo;

  const parts = [describeKind(info.kind), describeMode(info.mode)];
  if (info.kind === 'file') parts.push(`${info.fileCount} 个文件`, formatBytes(info.totalBytes));
  else parts.push(formatBytes(info.totalBytes));
  parts.push(formatRemaining(info.expiresAt));

  if (info.requiresPassword) {
    $('unlock-card').hidden = false;
    $('unlock-sub').textContent = `${parts.join(' · ')}`;
    setStatus('请输入密码后查看内容。');
    $('password-input').focus();
  } else {
    setStatus('正在打开…');
    await unlock('');
  }
}

async function unlock(password) {
  $('unlock-error').textContent = '';
  try {
    const result = await apiJson(`/api/shares/${state.shareId}/unlock`, {
      method: 'POST',
      body: { password },
    });
    state.token = result.accessToken;
    saveAccessToken(state.shareId, result.accessToken);
    state.share = result.share;

    $('unlock-card').hidden = true;
    setStatus('');
    await renderContent();
  } catch (err) {
    if (err.status === 403) {
      $('unlock-error').textContent = '密码错误，请重试。';
      $('password-input').select();
      return;
    }
    if (err.status === 410) {
      setStatus('该分享已失效。', 'danger');
      $('unlock-card').hidden = true;
      return;
    }
    if (err.status === 404) {
      setStatus('未找到该分享，请检查链接是否正确。', 'danger');
      $('unlock-card').hidden = true;
      return;
    }
    $('unlock-error').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// 内容渲染
// ---------------------------------------------------------------------------

async function renderContent() {
  const share = state.share;
  $('content-card').hidden = false;
  $('content-title').textContent = share.title || '分享内容';

  const meta = [
    describeKind(share.kind),
    describeMode(share.mode),
    formatRemaining(share.expiresAt),
  ];
  if (share.kind === 'file') meta.push(`${share.files.length} 个文件`, formatBytes(share.totalBytes));
  $('content-meta').textContent = meta.join(' · ');

  $('notices').replaceChildren();
  if (share.burnAfterRead) notice('阅后即焚，仅可查看一次。', 'warn');
  if (share.maxDownloads) notice(`最多可被取走 ${share.maxDownloads} 次${share.downloadsLeft === null ? '' : `（剩余 ${share.downloadsLeft} 次）`}。`, 'warn');
  if (share.mode === 'p2p') notice('需要发送方保持页面开启。', '');
  $('content-title').focus({ preventScroll: true });

  if (share.kind === 'text') {
    if (share.mode === 'staged') await loadTextStaged();
    else renderTextP2P();
    return;
  }

  if (share.mode === 'staged') renderFilesStaged();
  else renderFilesP2P();
}

// ------------------------------- 文字：暂存 -------------------------------

async function loadTextStaged() {
  $('text-panel').hidden = false;
  $('text-view').textContent = '正在读取…';

  try {
    const response = await fetch(`/api/shares/${state.shareId}/text`, { headers: authHeaders() });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw Object.assign(new Error(data.message ?? '读取失败，请稍后重试。'), { status: response.status });
    }
    const text = await response.text();
    $('text-view').textContent = text;
    renderTextActions(text);
    if (state.share.burnAfterRead) notice('该文字已失效。', 'danger');
  } catch (err) {
    $('text-view').textContent = '';
    setStatus(`读取失败：${err.message}`, 'danger');
  }
}

function renderTextActions(text) {
  const actions = $('text-actions');
  actions.replaceChildren();

  const copy = document.createElement('button');
  copy.className = 'primary';
  copy.textContent = '复制文字';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.textContent = '已复制 ✓';
    } catch {
      copy.textContent = '复制失败，请手动选择文本。';
    }
  });

  const download = document.createElement('button');
  download.textContent = '下载为 .txt';
  download.addEventListener('click', () => {
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${state.share.title || state.shareId}.txt`);
  });

  actions.append(copy, download);
}

// ------------------------------- 文字：P2P -------------------------------

function renderTextP2P() {
  $('text-panel').hidden = false;
  $('text-view').textContent = '正在等待发送方…';
  $('text-actions').replaceChildren();
  $('transfer').hidden = true;
  startTextReceiver();
}

function startTextReceiver() {
  const share = state.share;

  const signaling = createSignaling({
    shareId: share.id,
    role: 'receiver',
    token: state.token,
    handlers: {
      onPeerJoined: (role) => {
        if (role === 'sender' || role === 'upload') {
          notice('发送方已连接，正在接收文字…', 'ok');
          receiveOnce();
        }
      },
      onPeerLeft: () => {
        if (!state.finished) $('text-view').textContent = '发送方离开了，请让他重新打开分享页面。';
      },
      onPayload: (payload) => {
        if (payload?.k === 'path' && payload.path === PATH.RELAY) {
          notice('正在由服务器转交接收（不会保存到服务器）…', '');
          receiveOnce();
        }
      },
      onClose: () => {
        if (!state.finished) notice('连接已断开，请刷新页面。', 'danger');
      },
    },
  });
  state.signaling = signaling;

  let receiving = false;
  async function receiveOnce() {
    if (receiving || state.finished) return;
    receiving = true;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`/api/relay/${share.id}/text`, { headers: authHeaders() });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw Object.assign(new Error(data.message ?? '接收失败，请稍后重试。'), { status: response.status });
        }
        const text = await response.text();
        state.finished = true;
        $('text-view').textContent = text;
        renderTextActions(text);
        notice('文字已接收。', 'ok');
        if (share.burnAfterRead) notice('该文字已失效，无法再次查看。', 'danger');
        return;
      } catch (err) {
        if (attempt === 3) {
          notice(`接收失败：${err.message}`, 'danger');
          $('text-view').textContent = '接收失败，请让发送方重新打开分享页面。';
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  signaling.ready
    .then(({ peers }) => {
      if (peers.some((role) => role === 'sender' || role === 'upload')) {
        notice('发送方已在等待，正在接收文字…', 'ok');
        receiveOnce();
      }
    })
    .catch((err) => notice(`连接失败：${err.message}`, 'danger'));
}

// ------------------------------- 文件：暂存 -------------------------------

function renderFilesStaged() {
  const share = state.share;
  $('file-panel').hidden = false;
  $('file-actions').replaceChildren();

  const list = $('file-list');
  list.replaceChildren();
  for (const file of share.files) {
    const li = document.createElement('li');
    // Drag Handle Illusion：悬停时左侧 ⋮⋮ 淡入（仅装饰，不进无障碍树）
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⋮⋮';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.relPath;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(file.size);
    li.append(handle, name, size);
    list.append(li);
  }

  const useDirectory = supportsDirectoryPicker() && share.files.length > 1;
  const saveAll = document.createElement('button');
  saveAll.className = 'primary';
  saveAll.textContent = useDirectory ? '选择文件夹并全部保存' : '全部下载';
  saveAll.addEventListener('click', () => downloadAllStaged(useDirectory));
  $('file-actions').append(saveAll);

  for (const [idx, file] of share.files.entries()) {
    const single = document.createElement('button');
    single.textContent = `下载 ${file.name}`;
    single.addEventListener('click', () => downloadOneStaged(idx, file));
    $('file-actions').append(single);
  }
}

function stagedFileUrl(idx) {
  return `/api/shares/${state.shareId}/files/${idx}?t=${encodeURIComponent(state.token)}`;
}

async function downloadOneStaged(idx, file) {
  const progress = $('progress');
  const transferText = $('transfer-text');
  $('transfer').hidden = false;

  let sink = null;
  if (supportsDirectoryPicker()) {
    try {
      const directory = await pickDirectory();
      sink = await createFileSystemSink({ directoryHandle: directory, relativePath: file.relPath });
    } catch {
      sink = null; // 用户取消了目录选择，退回普通下载
    }
  }

  try {
    if (!sink) {
      const response = await fetch(stagedFileUrl(idx), { headers: authHeaders() });
      if (!response.ok) throw new Error('下载失败，请稍后重试。');
      const blob = await response.blob();
      saveBlob(blob, file.name);
    } else {
      const response = await fetch(stagedFileUrl(idx), { headers: authHeaders() });
      if (!response.ok) throw new Error('下载失败，请稍后重试。');
      const reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await sink.write(value);
        progress.value = file.size > 0 ? (received / file.size) * 100 : 100;
        transferText.textContent = `${file.name}：${formatBytes(received)} / ${formatBytes(file.size)}`;
      }
      await sink.close();
    }
    transferText.textContent = `${file.name} 已保存`;
  } catch (err) {
    transferText.textContent = `下载失败：${err.message}`;
  }
}

async function downloadAllStaged(useDirectory) {
  const share = state.share;
  let directory = null;

  if (useDirectory) {
    try {
      directory = await pickDirectory();
    } catch {
      directory = null;
    }
  }

  const progress = $('progress');
  const transferText = $('transfer-text');
  $('transfer').hidden = false;

  let done = 0;
  for (const [idx, file] of share.files.entries()) {
    try {
      const response = await fetch(stagedFileUrl(idx), { headers: authHeaders() });
      if (!response.ok) throw new Error('下载失败，请稍后重试。');

      if (directory) {
        const sink = await createFileSystemSink({ directoryHandle: directory, relativePath: file.relPath });
        const reader = response.body.getReader();
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          await sink.write(value);
        }
        await sink.close();
      } else {
        saveBlob(await response.blob(), file.name);
      }
      done += 1;
      progress.value = (done / share.files.length) * 100;
      transferText.textContent = `已完成 ${done} / ${share.files.length}`;
    } catch (err) {
      transferText.textContent = `「${file.name}」失败：${err.message}`;
      return;
    }
  }
  transferText.textContent = directory ? `全部 ${done} 个文件已保存到你选择的文件夹` : `已触发 ${done} 个文件的下载`;
}

async function pickDirectory() {
  if (!supportsDirectoryPicker()) throw new Error('浏览器不支持选择文件夹');
  if (state.directoryHandle) return state.directoryHandle;
  state.directoryHandle = await window.showDirectoryPicker({ id: 'kuaichuan', mode: 'readwrite' });
  return state.directoryHandle;
}

// ------------------------------- 文件：P2P -------------------------------

function renderFilesP2P() {
  const share = state.share;
  $('file-panel').hidden = false;

  const list = $('file-list');
  list.replaceChildren();
  for (const file of share.files) {
    const li = document.createElement('li');
    // Drag Handle Illusion：悬停时左侧 ⋮⋮ 淡入（仅装饰，不进无障碍树）
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⋮⋮';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.relPath;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatBytes(file.size);
    li.append(handle, name, size);
    list.append(li);
  }

  const actions = $('file-actions');
  actions.replaceChildren();

  const start = document.createElement('button');
  start.className = 'primary';
  start.textContent = supportsDirectoryPicker() ? '选择文件夹并开始接收' : '开始接收';
  start.addEventListener('click', async () => {
    start.disabled = true;
    start.textContent = '等待发送方…';
    if (supportsDirectoryPicker()) {
      try {
        await pickDirectory();
      } catch {
        notice('未选择文件夹，文件将保存至浏览器下载目录。', 'warn');
      }
    }
    startFileReceiver();
  });
  actions.append(start);

}

function startFileReceiver() {
  const share = state.share;
  const progress = $('progress');
  const transferText = $('transfer-text');

  $('transfer').hidden = false;
  progress.value = 0;
  transferText.textContent = '正在连接发送方…';

  const totalBytes = share.files.reduce((sum, file) => sum + file.size, 0);
  const startedAt = Date.now();
  let receivedBytes = 0;
  let currentSink = null;
  let currentFile = null;
  const memorySinks = new Map();

  const signaling = createSignaling({
    shareId: share.id,
    role: 'receiver',
    token: state.token,
    handlers: {
      onPeerJoined: (role) => {
        if (role === 'sender' || role === 'upload') transferText.textContent = '发送方已连接，正在建立传输…';
      },
      onPeerLeft: () => {
        if (!state.finished) transferText.textContent = '发送方离开了，请让他重新打开分享页面。';
      },
      onPayload: (payload) => handlePayload(payload),
      onClose: () => {
        if (!state.finished) transferText.textContent = '连接已断开，请刷新页面。';
      },
    },
  });
  state.signaling = signaling;

  async function handlePayload(payload) {
    if (payload?.k === 'path' && payload.path === PATH.RELAY) {
      notice('无法直接连接，正在由服务器转交接收（不会保存到服务器）…', 'warn');
      await receiveViaRelay();
      return;
    }
    if (!state.rtc && payload?.k === 'sdp' && payload.sdp?.type === 'offer') {
      await setupWebRTC();
    }
    try {
      const answer = await state.rtc?.handleSignal(payload);
      if (answer) signaling.send({ k: 'sdp', sdp: answer });
    } catch {
      transferText.textContent = '连接失败，请刷新页面重试。';
    }
  }

  async function setupWebRTC() {
    let iceServers = [];
    try {
      const rtcConfig = await apiJson(`/api/rtc-config?share=${share.id}`, { token: state.token });
      iceServers = rtcConfig.iceServers ?? [];
    } catch {
      iceServers = [];
    }

    state.rtc = new RtcPeer({
      iceServers,
      role: 'receiver',
      handlers: {
        onCandidate: (candidate) => signaling.send({ k: 'candidate', candidate }),
        onOpen: () => {
          transferText.textContent = '已直接连接，正在接收…';
          notice('已连接发送方，正在直接接收。', 'ok');
        },
        onData: (data) => onChannelData(data),
        onFailed: () => {
          transferText.textContent = '直接连接中断，正在改为由服务器转交…';
        },
      },
    });

    // 通道打开由数据通道事件驱动；这里等一小会儿保证 UI 状态先更新
    await state.rtc.waitForChannel(CHANNEL_TIMEOUT_MS).catch(() => {});
  }

  async function onChannelData(data) {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (message.k === 'file') {
        currentFile = share.files[message.idx];
        memorySinks.delete(message.idx);
        currentSink = await makeSink(message.idx, currentFile);
        transferText.textContent = `正在接收 ${currentFile.relPath}…`;
      } else if (message.k === 'end') {
        await finishSink(message.idx, currentFile);
        currentSink = null;
      }
      return;
    }

    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!currentSink || !currentFile) return;
    await currentSink.write(chunk);
    receivedBytes += chunk.byteLength;
    progress.value = totalBytes > 0 ? (receivedBytes / totalBytes) * 100 : 0;
    transferText.textContent = describeProgress({ sent: receivedBytes, total: totalBytes, startedAt });
  }

  async function makeSink(idx, file) {
    if (state.directoryHandle) {
      try {
        return await createFileSystemSink({ directoryHandle: state.directoryHandle, relativePath: file.relPath });
      } catch {
        notice('写入所选文件夹失败，文件将保存至浏览器下载目录。', 'warn');
      }
    }
    const sink = createMemorySink();
    memorySinks.set(idx, sink);
    return sink;
  }

  async function finishSink(idx, file) {
    if (!file) return;
    const memory = memorySinks.get(idx);
    if (memory) {
      memorySinks.delete(idx);
      saveBlob(memory.toBlob(file.mime || 'application/octet-stream'), file.name);
      return;
    }
    // FSA 的 sink 在最后关闭
    if (currentSink?.kind === 'fs') await currentSink.close();
  }

  async function receiveViaRelay() {
    progress.value = 0;
    receivedBytes = 0;

    for (const [idx, file] of share.files.entries()) {
      try {
        const sink = state.directoryHandle
          ? await createFileSystemSink({ directoryHandle: state.directoryHandle, relativePath: file.relPath })
          : createMemorySink();

        const result = await readViaRelay({
          shareId: share.id,
          idx,
          token: state.token,
          sink,
          totalHint: file.size,
          onProgress: (received) => {
            const overall = receivedBytes + received;
            progress.value = totalBytes > 0 ? (overall / totalBytes) * 100 : 0;
            transferText.textContent = describeProgress({ sent: overall, total: totalBytes, startedAt });
          },
        });

        if (sink.kind === 'memory') {
          saveBlob(sink.toBlob(file.mime || 'application/octet-stream'), file.name);
        }
        receivedBytes += result.received;
      } catch (err) {
        transferText.textContent = `「${file.relPath}」接收失败：${err.message}`;
        return;
      }
    }

    state.finished = true;
    progress.value = 100;
    transferText.textContent = `全部 ${share.files.length} 个文件已接收`;
    notice('接收完成。', 'ok');
  }

  signaling.ready
    .then(({ peers }) => {
      if (peers.some((role) => role === 'sender' || role === 'upload')) {
        transferText.textContent = '发送方已连接，正在建立传输…';
      } else {
        transferText.textContent = '正在等待发送方打开页面…';
      }
    })
    .catch((err) => {
      transferText.textContent = `连接失败：${err.message}`;
    });
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function shareIdFromPath() {
  const match = /^\/s\/([A-Za-z0-9]{1,64})\/?$/.exec(window.location.pathname);
  return match ? match[1] : '';
}

async function init() {
  state.config = await loadPublicConfig();
  $('app-name').textContent = state.config.appName;
  document.title = `接收分享 · ${state.config.appName}`;

  state.shareId = shareIdFromPath();
  if (!state.shareId) {
    setStatus('链接格式不正确。', 'danger');
    return;
  }

  $('unlock-form').addEventListener('submit', (event) => {
    event.preventDefault();
    unlock($('password-input').value.trim());
  });

  const cached = getAccessToken(state.shareId);
  try {
    await loadPublicInfo();
    if (cached && !state.token) {
      // 同一个标签页里刷新过：直接用缓存令牌试试
      try {
        state.token = cached;
        const meta = await apiJson(`/api/shares/${state.shareId}`, { token: cached });
        state.share = meta;
        $('unlock-card').hidden = true;
        setStatus('');
        await renderContent();
      } catch {
        state.token = null;
      }
    }
  } catch (err) {
    if (err.status === 404) setStatus('未找到该分享，请检查链接是否正确。', 'danger');
    else if (err.status === 410) setStatus('该分享已失效。', 'danger');
    else setStatus(`读取失败：${err.message}`, 'danger');
  }
}

init().catch(() => setStatus('页面加载失败，请刷新重试。', 'danger'));
