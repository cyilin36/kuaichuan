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
import { CONTROL, createTransferControls } from './transfer-control.js';
import { createStagedDownloader } from './staged-download.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  shareId: '',
  publicInfo: null,
  share: null,
  token: null,
  directoryHandle: null,
  signaling: null,
  receiveButton: null,
  rtc: null,
  receiving: false,
  finished: false,
  controls: null,
  activeController: null,
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

function setTransferStatus(text, tone = '') {
  const el = $('transfer-status');
  el.className = `field-hint ${tone}`;
  el.textContent = text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // 直连没有用户可选的有效期，只在发送方在线期间可用
  if (info.mode !== 'p2p') parts.push(formatRemaining(info.expiresAt));

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
  ];
  // 直连不展示倒计时，发送方在线状态才是它能否继续传输的依据
  if (share.mode !== 'p2p') meta.push(formatRemaining(share.expiresAt));
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
  let stopped = false;
  let abort = null;

  const signaling = createSignaling({
    shareId: share.id,
    role: 'receiver',
    token: state.token,
    handlers: {
      onPeerJoined: (role) => {
        if (state.finished || stopped) return;
        if (role === 'sender' || role === 'upload') {
          notice('发送方已连接，正在接收文字…', 'ok');
          receiveOnce();
        }
      },
      onPeerLeft: () => {
        if (!state.finished && !stopped) $('text-view').textContent = '发送方离开了，请让他重新打开分享页面。';
      },
      onPayload: (payload) => {
        if (state.finished || stopped) return;
        if (payload?.k === 'control' && payload.action === 'stop') {
          stopped = true;
          state.finished = true;
          abort?.abort();
          signaling.close();
          state.controls.setState(CONTROL.STOPPED);
          notice('发送方已停止发送文字。', 'warn');
          return;
        }
        if (payload?.k === 'path' && payload.path === PATH.RELAY) {
          notice('正在由服务器转交接收（不会保存到服务器）…', '');
          receiveOnce();
        }
      },
      onClose: () => {
        if (!state.finished && !stopped) {
          state.controls.setState(CONTROL.ERROR);
          notice('连接已断开，请刷新页面。', 'danger');
        }
      },
    },
  });
  state.signaling = signaling;

  state.controls.setState(CONTROL.WAITING, { allowPause: false });
  state.activeController = {
    pause() {},
    resume() {},
    stop() {
      if (stopped) return;
      stopped = true;
      state.finished = true;
      try {
        signaling.send({ k: 'control', action: 'stop' });
      } catch {
        // 对端可能已断开
      }
      abort?.abort();
      signaling.close();
      state.controls.setState(CONTROL.STOPPED);
      notice('已停止接收文字。', 'warn');
    },
  };

  let receiving = false;
  async function receiveOnce() {
    if (receiving || state.finished || stopped) return;
    receiving = true;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (stopped) return;
      abort = new AbortController();
      try {
        const response = await fetch(`/api/relay/${share.id}/text`, {
          headers: authHeaders(),
          signal: abort.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw Object.assign(new Error(data.message ?? '接收失败，请稍后重试。'), { status: response.status });
        }
        const text = await response.text();
        if (stopped) return;
        state.finished = true;
        state.controls.setState(CONTROL.DONE);
        $('text-view').textContent = text;
        renderTextActions(text);
        notice('文字已接收。', 'ok');
        if (share.burnAfterRead) notice('该文字已失效，无法再次查看。', 'danger');
        return;
      } catch (err) {
        if (stopped) return;
        if (attempt === 3) {
          state.controls.setState(CONTROL.ERROR);
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
      if (state.finished || stopped) return;
      if (peers.some((role) => role === 'sender' || role === 'upload')) {
        notice('发送方已在等待，正在接收文字…', 'ok');
        receiveOnce();
      }
    })
    .catch((err) => {
      state.controls.setState(CONTROL.ERROR);
      notice(`连接失败：${err.message}`, 'danger');
    });
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
  saveAll.addEventListener('click', () => startStagedDownload({
    indices: share.files.map((_, index) => index),
    useDirectory,
  }));
  $('file-actions').append(saveAll);

  for (const [idx, file] of share.files.entries()) {
    const single = document.createElement('button');
    single.textContent = `下载 ${file.name}`;
    single.addEventListener('click', () => startStagedDownload({ indices: [idx], useDirectory: supportsDirectoryPicker() }));
    $('file-actions').append(single);
  }
}

async function startStagedDownload({ indices, useDirectory }) {
  if (state.activeController) {
    notice('已有下载任务在进行，请先停止。', 'warn');
    return;
  }

  const share = state.share;
  const files = indices.map((index) => share.files[index]).filter(Boolean);
  if (files.length === 0) return;

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
  progress.value = 0;
  setTransferStatus('');

  const downloader = createStagedDownloader({
    share,
    token: state.token,
    files,
    directoryHandle: directory,
    progress,
    transferText,
    controls: state.controls,
    onStatus: setTransferStatus,
    onNotice: notice,
  });

  state.activeController = downloader;
  try {
    await downloader.start();
  } finally {
    state.activeController = null;
  }
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
    start.textContent = '正在连接发送方…';
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
  state.receiveButton = start;
}

function startFileReceiver() {
  const share = state.share;
  const progress = $('progress');
  const transferText = $('transfer-text');

  $('transfer').hidden = false;
  progress.value = 0;
  transferText.textContent = '正在连接发送方…';
  setTransferStatus('');

  let finished = false;
  let stopped = false;
  let paused = false;
  let mode = null;
  let transferStarted = false;
  let receivedBytes = 0;
  let completedFiles = 0;
  let currentSink = null;
  let currentFile = null;
  let currentIdx = 0;
  let relayAbort = null;
  let relayRunning = false;
  let dataChain = Promise.resolve();
  const memorySinks = new Map();
  const pauseWaiters = new Set();

  state.finished = false;

  const totalBytes = share.files.reduce((sum, file) => sum + file.size, 0);
  const startedAt = Date.now();

  const wakePause = () => {
    for (const resolve of pauseWaiters) resolve();
    pauseWaiters.clear();
  };

  const sendControl = (action, extra = {}) => {
    try {
      signaling.send({ k: 'control', action, ...extra });
    } catch {
      // 对端可能已断开
    }
  };

  function setReceiverAction(text) {
    if (!state.receiveButton) return;
    state.receiveButton.disabled = true;
    state.receiveButton.textContent = text;
  }

  function showProgress(sent) {
    progress.value = totalBytes > 0 ? Math.min(100, (sent / totalBytes) * 100) : 0;
    transferText.textContent = describeProgress({ sent, total: totalBytes, startedAt });
  }

  function finishReceive() {
    if (finished || stopped) return;
    finished = true;
    state.finished = true;
    progress.value = 100;
    transferText.textContent = `全部 ${share.files.length} 个文件已接收`;
    setReceiverAction('接收完成');
    state.controls.setState(CONTROL.DONE);
    setTransferStatus('接收完成。', 'ok');
    notice('接收完成。', 'ok');
  }

  function failReceive(message) {
    if (finished || stopped) return;
    finished = true;
    state.finished = true;
    transferText.textContent = message;
    setReceiverAction('接收失败');
    state.controls.setState(CONTROL.ERROR);
    setTransferStatus(message, 'danger');
  }

  const throwIfStopped = () => {
    if (stopped) {
      const error = new Error('传输已停止');
      error.code = 'transfer_stopped';
      throw error;
    }
  };

  async function waitIfPaused() {
    throwIfStopped();
    if (!paused) return;
    state.controls.setState(CONTROL.PAUSED);
    setTransferStatus('已暂停，可点击「继续」接着接收。', 'warn');
    while (paused && !stopped) {
      await new Promise((resolve) => pauseWaiters.add(resolve));
    }
    throwIfStopped();
    state.controls.setState(CONTROL.RUNNING, { allowPause: true });
    setTransferStatus('正在继续接收…');
  }

  async function cleanupCurrentSink() {
    const sink = currentSink;
    currentSink = null;
    if (currentFile) memorySinks.delete(currentIdx);
    currentFile = null;
    if (!sink) return;
    try {
      await sink.cleanup?.();
      await sink.close?.();
    } catch {
      // 清理失败不影响停止流程
    }
  }

  function stopReceiver(notify = true) {
    if (stopped || finished) return;
    if (notify) sendControl('stop');
    stopped = true;
    finished = true;
    state.finished = true;
    paused = false;
    wakePause();
    relayAbort?.abort();
    state.rtc?.close();
    state.rtc = null;
    signaling.close();
    state.controls.setState(CONTROL.STOPPED);
    setReceiverAction('已停止');
    setTransferStatus('已停止接收，未完成的文件已清理。', 'warn');
    cleanupCurrentSink().catch(() => {});
  }

  async function pauseReceive() {
    if (!transferStarted || finished || stopped || paused) return;
    paused = true;
    state.controls.setState(CONTROL.PAUSING);
    setTransferStatus('正在暂停…');
    sendControl('pause');
    relayAbort?.abort();
    await sleep(30);
    if (!finished && !stopped) {
      state.controls.setState(CONTROL.PAUSED);
      setTransferStatus(
        mode === 'relay' ? '已暂停。继续时将从当前文件开头接收。' : '已暂停。',
        'warn',
      );
    }
  }

  function resumeReceive() {
    if (finished || stopped || !paused) return;
    paused = false;
    wakePause();
    state.controls.setState(CONTROL.RUNNING, { allowPause: true });
    setTransferStatus('正在继续接收…');
    sendControl('resume');
  }

  function handleControl(payload) {
    if (!payload || finished || stopped) return;
    if (payload.action === 'pause') {
      paused = true;
      relayAbort?.abort();
      state.controls.setState(CONTROL.PAUSED);
      setTransferStatus('发送方已暂停。', 'warn');
      return;
    }
    if (payload.action === 'resume') {
      paused = false;
      wakePause();
      state.controls.setState(CONTROL.RUNNING, { allowPause: true });
      setTransferStatus('发送方已继续发送。', 'ok');
      return;
    }
    if (payload.action === 'stop') {
      stopReceiver(false);
    }
  }

  const signaling = createSignaling({
    shareId: share.id,
    role: 'receiver',
    token: state.token,
    handlers: {
      onPeerJoined: (role) => {
        if (finished || stopped || transferStarted) return;
        if (role === 'sender' || role === 'upload') {
          transferText.textContent = '发送方已连接，正在建立传输…';
          setReceiverAction('正在建立传输…');
        }
      },
      onPeerLeft: () => {
        if (!finished && !stopped) {
          transferText.textContent = '发送方离开了，请让他重新打开分享页面。';
          setReceiverAction('发送方已离开');
        }
      },
      onPayload: (payload) => {
        handlePayload(payload).catch(() => {
          if (!finished && !stopped) failReceive('接收失败，请刷新页面重试。');
        });
      },
      onClose: () => {
        if (!finished && !stopped) failReceive('连接已断开，请刷新页面重试。');
      },
    },
  });
  state.signaling = signaling;

  state.controls.setState(CONTROL.WAITING, { allowPause: false });
  state.activeController = {
    pause: pauseReceive,
    resume: resumeReceive,
    stop: () => stopReceiver(true),
  };

  async function handlePayload(payload) {
    if (finished || stopped) return;
    if (payload?.k === 'control') {
      handleControl(payload);
      return;
    }
    if (payload?.k === 'path' && payload.path === PATH.RELAY) {
      if (relayRunning) return;
      notice('无法直接连接，正在由服务器转交接收（不会保存到服务器）…', 'warn');
      state.rtc?.close();
      state.rtc = null;
      await cleanupCurrentSink();
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
      failReceive('连接失败，请刷新页面重试。');
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
          if (finished || stopped) return;
          mode = 'webrtc';
          transferStarted = true;
          state.controls.setState(CONTROL.RUNNING, { allowPause: true });
          transferText.textContent = '已直接连接，正在接收…';
          setReceiverAction('正在接收…');
          notice('已连接发送方，正在直接接收。', 'ok');
        },
        onData: (data) => {
          dataChain = dataChain
            .then(() => onChannelData(data))
            .catch(() => {
              if (!finished && !stopped) failReceive('接收失败，请刷新页面重试。');
            });
        },
        onFailed: () => {
          if (finished || stopped) return;
          transferText.textContent = '直接连接中断，正在改为由服务器转交…';
        },
      },
    });

    // 通道打开由数据通道事件驱动；这里等一小会儿保证 UI 状态先更新
    await state.rtc.waitForChannel(CHANNEL_TIMEOUT_MS).catch(() => {});
  }

  async function onChannelData(data) {
    if (finished || stopped) return;
    if (typeof data === 'string') {
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.k === 'file') {
        const file = share.files[message.idx];
        if (!file) return;
        currentIdx = message.idx;
        currentFile = file;
        memorySinks.delete(message.idx);
        currentSink = await makeSink(message.idx, currentFile);
        transferText.textContent = `正在接收 ${currentFile.relPath}…`;
      } else if (message.k === 'end') {
        // 先摘下当前文件的引用，避免关闭旧 sink 的异步过程被下一个文件打断。
        const sink = currentSink;
        const file = currentFile;
        currentSink = null;
        currentFile = null;
        await finishSink(message.idx, file, sink);
        completedFiles += 1;
        // 直连没有额外的结束信号，按收到的文件数判断整次接收是否完成。
        if (completedFiles >= share.files.length) finishReceive();
      }
      return;
    }

    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!currentSink || !currentFile) return;
    await currentSink.write(chunk);
    receivedBytes += chunk.byteLength;
    showProgress(receivedBytes);
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

  async function finishSink(idx, file, sink) {
    if (!file) return;
    const memory = memorySinks.get(idx);
    if (memory) {
      memorySinks.delete(idx);
      saveBlob(memory.toBlob(file.mime || 'application/octet-stream'), file.name);
      return;
    }
    if (sink?.kind === 'fs') await sink.close();
  }

  async function makeRelaySink(file) {
    if (state.directoryHandle) {
      try {
        return await createFileSystemSink({
          directoryHandle: state.directoryHandle,
          relativePath: file.relPath,
        });
      } catch {
        notice('写入所选文件夹失败，文件将保存至浏览器下载目录。', 'warn');
      }
    }
    return createMemorySink();
  }

  async function receiveViaRelay() {
    mode = 'relay';
    transferStarted = true;
    relayRunning = true;
    receivedBytes = 0;
    completedFiles = 0;
    state.controls.setState(CONTROL.RUNNING, { allowPause: true });
    setReceiverAction('正在接收…');

    for (let idx = 0; idx < share.files.length; idx += 1) {
      const file = share.files[idx];
      let done = false;
      let retries = 0;

      while (!done) {
        await waitIfPaused();
        if (stopped) return;
        relayAbort = new AbortController();
        let sink = null;

        try {
          sink = await makeRelaySink(file);
          currentSink = sink;
          currentFile = file;
          currentIdx = idx;
          const base = receivedBytes;

          const result = await readViaRelay({
            shareId: share.id,
            idx,
            token: state.token,
            sink,
            totalHint: file.size,
            signal: relayAbort.signal,
            onProgress: (received) => showProgress(base + received),
          });

          if (stopped) return;
          if (sink.kind === 'memory') {
            saveBlob(sink.toBlob(file.mime || 'application/octet-stream'), file.name);
          }
          currentSink = null;
          currentFile = null;
          receivedBytes = base + result.received;
          completedFiles += 1;
          showProgress(receivedBytes);
          sendControl('file-done', { idx });
          done = true;
        } catch (err) {
          if (stopped) return;
          await cleanupCurrentSink();
          if (err.code === 'aborted' || relayAbort.signal.aborted) {
            await waitIfPaused();
            continue;
          }
          if (retries < 3) {
            retries += 1;
            setTransferStatus(`接收中断，正在重试（${retries}/3）…`, 'warn');
            await sleep(800 * retries);
            continue;
          }
          failReceive(`「${file.relPath}」接收失败：${err.message}`);
          return;
        }
      }
    }

    relayRunning = false;
    if (!stopped) finishReceive();
  }

  signaling.ready
    .then(({ peers }) => {
      if (finished || stopped || transferStarted) return;
      if (peers.some((role) => role === 'sender' || role === 'upload')) {
        transferText.textContent = '发送方已连接，正在建立传输…';
        setReceiverAction('正在建立传输…');
      } else {
        transferText.textContent = '正在等待发送方打开页面…';
        setReceiverAction('等待发送方…');
      }
    })
    .catch(() => {
      failReceive('连接失败，请刷新页面重试。');
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

  state.controls = createTransferControls({
    container: $('transfer-actions'),
    pauseButton: $('pause-btn'),
    stopButton: $('stop-btn'),
    onChange: (action) => {
      const controller = state.activeController;
      if (!controller) return;
      if (action === 'pause') controller.pause();
      else if (action === 'resume') controller.resume();
      else if (action === 'stop') controller.stop();
    },
  });

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
