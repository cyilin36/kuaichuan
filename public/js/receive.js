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
  CHANNEL_TIMEOUT_MS, PATH, RtcPeer, createMemorySink, createSignaling,
  openArchiveTarget, readViaRelay, saveBlob,
} from './transport.js';
import { buildFileRows, normalizeIndices, visibleRows } from './file-tree.js';
import { fileIcon, folderIcon } from './icons.js';
import { CONTROL, createTransferControls } from './transfer-control.js';
import { createStagedDownloader } from './staged-download.js';
import { createZipWriter, deriveArchiveLayout } from './zip.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  shareId: '',
  publicInfo: null,
  share: null,
  token: null,
  signaling: null,
  rtc: null,
  receiving: false,
  finished: false,
  controls: null,
  activeController: null,
  // 文件树里被收起的文件夹路径（仅当前页面有效）
  collapsed: new Set(),
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

// ------------------------------- 文件：列表与下载入口 -------------------------------

function setDownloadsBusy(busy) {
  for (const button of document.querySelectorAll('#file-list .row-download, #file-actions button')) {
    button.disabled = busy;
  }
}

// 选目录是异步的，activeController 还来不及挂上；用这个标记挡住连点开出的第二条下载
let downloadStarting = false;

/** 把分享里的文件渲染成「文件夹 + 文件」行；文件夹行可展开/收起，每行右侧一个下载按钮 */
function renderFileRows(files, onDownload) {
  const list = $('file-list');
  list.replaceChildren();

  for (const row of visibleRows(buildFileRows(files), state.collapsed)) {
    const li = document.createElement('li');
    li.className = row.type === 'folder' ? 'is-folder' : 'is-file';
    li.style.setProperty('--depth', String(row.depth));

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name;

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = row.type === 'folder' ? `${row.count} 个文件` : formatBytes(row.size);

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'tiny row-download';
    download.textContent = row.type === 'folder' ? '打包下载' : '下载';
    download.setAttribute('aria-label', `下载 ${row.path || row.name}`);
    download.addEventListener('click', () => onDownload(row));

    if (row.type === 'folder') {
      const collapsed = state.collapsed.has(row.path);
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'disclosure';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${row.path || row.name}`);
      toggle.textContent = collapsed ? '▸' : '▾';
      toggle.addEventListener('click', () => {
        toggleFolder(row.path);
        renderFileRows(files, onDownload);
        // 重新渲染会重建下载按钮，恢复「下载中」的禁用状态
        setDownloadsBusy(Boolean(state.activeController) || downloadStarting);
      });
      li.append(toggle, folderIcon(), name, size, download);
    } else {
      // Drag Handle Illusion：悬停时左侧 ⋮⋮ 淡入（仅装饰，不进无障碍树）
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.setAttribute('aria-hidden', 'true');
      handle.textContent = '⋮⋮';
      li.append(handle, fileIcon(), name, size, download);
    }

    list.append(li);
  }
}

function toggleFolder(path) {
  if (state.collapsed.has(path)) state.collapsed.delete(path);
  else state.collapsed.add(path);
}

function renderDownloadAll(label, onClick) {
  const actions = $('file-actions');
  actions.replaceChildren();
  const all = document.createElement('button');
  all.className = 'primary';
  all.textContent = label;
  all.addEventListener('click', onClick);
  actions.append(all);
  return all;
}

// ------------------------------- 文件：暂存 -------------------------------

function renderFilesStaged() {
  const share = state.share;
  $('file-panel').hidden = false;

  renderFileRows(share.files, (row) => {
    if (row.type === 'folder') {
      downloadStagedArchive(row.indices);
    } else {
      downloadStagedFile(row.idx);
    }
  });

  if (share.files.length > 1) {
    renderDownloadAll('打包下载全部', () => downloadStagedArchive(
      share.files.map((file) => file.idx),
    ));
  } else if (share.files.length === 1) {
    renderDownloadAll('下载全部', () => downloadStagedFile(share.files[0].idx));
  }
}

/** 单文件：保持原来的流式下载、Range 断点续传与暂停/继续 */
async function downloadStagedFile(idx) {
  if (state.activeController || downloadStarting) {
    notice('已有下载任务在进行，请先停止。', 'warn');
    return;
  }

  const share = state.share;
  const file = share.files.find((item) => item.idx === idx);
  if (!file) return;

  downloadStarting = true;
  setDownloadsBusy(true);

  try {
    const progress = $('progress');
    const transferText = $('transfer-text');
    $('transfer').hidden = false;
    progress.value = 0;
    setTransferStatus('');

    const downloader = createStagedDownloader({
      share,
      token: state.token,
      files: [file],
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
  } finally {
    downloadStarting = false;
    setDownloadsBusy(false);
  }
}

/**
 * 多文件/文件夹：由服务器流式打包成一个 zip，浏览器原生下载。
 * 先用 HEAD 预检，避免把「次数不足/已失效」的错误响应当成文件下载下来。
 */
async function downloadStagedArchive(indices) {
  if (state.activeController || downloadStarting) {
    notice('已有下载任务在进行，请先停止。', 'warn');
    return;
  }

  const share = state.share;
  const byIdx = new Map(share.files.map((file) => [file.idx, file]));
  const files = [...new Set(indices)].map((idx) => byIdx.get(idx)).filter(Boolean);
  if (files.length === 0) return;

  const left = share.downloadsLeft;
  if (left !== null && left < files.length) {
    notice(`剩余可下载次数不足（${left} 次），无法打包 ${files.length} 个文件，请逐个下载。`, 'warn');
    return;
  }

  const layout = deriveArchiveLayout({
    files: files.map((file) => ({ idx: file.idx, relPath: file.relPath })),
    fallbackName: share.title || `快传-${state.shareId}`,
  });
  const url = `/api/shares/${share.id}/archive?idx=${files.map((file) => file.idx).join(',')}`;

  downloadStarting = true;
  setDownloadsBusy(true);
  try {
    let response;
    try {
      response = await fetch(url, { method: 'HEAD', headers: authHeaders() });
    } catch {
      notice('打包下载失败：网络错误，请稍后重试。', 'danger');
      return;
    }

    if (!response.ok) {
      const messages = {
        401: '登录已过期，请刷新页面后重试。',
        400: '打包参数有误，请刷新页面后重试。',
        409: '该分享正在被取走，请稍后再试。',
        410: '分享已失效或剩余下载次数不足，请刷新后逐个下载。',
      };
      notice(messages[response.status] ?? '打包下载失败，请稍后重试。', 'danger');
      return;
    }

    // HEAD 通过后再交给浏览器原生下载：服务端流式打包，不占浏览器内存
    state.controls.hide();
    $('transfer').hidden = true;
    const anchor = document.createElement('a');
    anchor.href = `${url}&t=${encodeURIComponent(state.token)}`;
    anchor.download = layout.archiveName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    notice('已开始打包下载，保存进度见浏览器下载列表；单文件下载仍可暂停/继续。', 'ok');
  } finally {
    downloadStarting = false;
    setDownloadsBusy(false);
  }
}

// ------------------------------- 文件：P2P -------------------------------

function renderFilesP2P() {
  const share = state.share;
  $('file-panel').hidden = false;

  renderFileRows(share.files, (row) => {
    if (row.type === 'folder') {
      startP2PDownload({ indices: row.indices, archive: true });
    } else {
      startP2PDownload({ indices: [row.idx], archive: false });
    }
  });

  if (share.files.length > 1) {
    renderDownloadAll('打包下载全部', () => startP2PDownload({
      indices: share.files.map((file) => file.idx),
      archive: true,
    }));
  } else if (share.files.length === 1) {
    renderDownloadAll('下载全部', () => startP2PDownload({
      indices: [share.files[0].idx],
      archive: false,
    }));
  }
}

function startP2PDownload(options) {
  if (state.activeController) {
    notice('已有下载任务在进行，请先停止。', 'warn');
    return;
  }
  // 不 await：选择保存位置要用掉这次点击的用户手势，由 startFileReceiver 自己收尾
  startFileReceiver(options).catch((err) => {
    downloadStarting = false;
    setDownloadsBusy(false);
    if (err?.code === 'cancelled') {
      setTransferStatus('已取消打包下载。', 'warn');
      return;
    }
    setTransferStatus('下载启动失败，请重试。', 'danger');
  });
}

async function startFileReceiver({ indices, archive = false } = {}) {
  const share = state.share;
  const byIdx = new Map(share.files.map((file) => [file.idx, file]));
  // 焚毁/中继清理后 files 表可能有序号空洞，范围按最大序号算
  const maxIndexExclusive = share.files.reduce((max, file) => Math.max(max, file.idx), -1) + 1;
  const wantedAll = normalizeIndices(indices, maxIndexExclusive);
  const wantedFiles = wantedAll.map((idx) => byIdx.get(idx)).filter(Boolean);
  const wanted = wantedFiles.map((file) => file.idx);
  if (wanted.length === 0) return;
  if (downloadStarting) return;

  downloadStarting = true;
  const wantedSet = new Set(wanted);
  const totalBytes = wantedFiles.reduce((sum, file) => sum + file.size, 0);

  // 直连整包由接收端组装：安全上下文下边收边写用户选的文件，否则放内存
  let archiveTarget = null;
  let zip = null;
  let completedEntries = 0;
  let archiveFinalized = false;
  let entryNames = new Map();
  if (archive) {
    const layout = deriveArchiveLayout({
      files: wantedFiles.map((file) => ({ idx: file.idx, relPath: file.relPath })),
      fallbackName: share.title || `快传-${share.id}`,
    });
    entryNames = new Map(layout.entries.map((entry) => [entry.idx, entry.name]));
    try {
      archiveTarget = await openArchiveTarget({
        name: layout.archiveName,
        totalBytes,
        onNotice: notice,
      });
    } catch (err) {
      downloadStarting = false;
      if (err?.code === 'cancelled') {
        notice('已取消打包下载。', '');
        return;
      }
      notice(`无法创建压缩包：${err.message}`, 'danger');
      return;
    }
    zip = createZipWriter({
      write: (chunk) => archiveTarget.sink.write(chunk),
      truncate: (offset) => archiveTarget.sink.truncate(offset),
    });
  }

  // 所有 zip 操作串成一条队列：停止/失败时的 abortEntry/finish 不会和正在写的块交错
  let zipQueue = Promise.resolve();
  function runZip(task) {
    const run = zipQueue.then(task, task);
    zipQueue = run.catch(() => {});
    return run;
  }

  setDownloadsBusy(true);

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
  let relayAbort = null;
  let relayRunning = false;
  let dataChain = Promise.resolve();
  const completedSet = new Set();
  const pauseWaiters = new Set();

  state.finished = false;

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

  // 告诉发送方本轮只要哪几个文件（发送方会先问一次，连接就绪时也主动补发）
  const sendSelect = () => {
    try {
      signaling.send({ k: 'control', action: 'select', indices: wanted });
    } catch {
      // 对端可能已断开
    }
  };

  // 每轮结束都断开本轮连接，收发双方都回到「等待下一次下载」状态
  function teardownRound() {
    state.activeController = null;
    state.signaling = null;
    downloadStarting = false;
    try {
      signaling.close();
    } catch {
      // 忽略关闭失败
    }
    state.rtc?.close();
    state.rtc = null;
    setDownloadsBusy(false);
  }

  function showProgress(sent) {
    progress.value = totalBytes > 0 ? Math.min(100, (sent / totalBytes) * 100) : 0;
    transferText.textContent = describeProgress({ sent, total: totalBytes, startedAt });
  }

  /** 收尾压缩包：正常/停止/失败都尽量保存已完成条目，避免比逐个下载更差 */
  async function finalizeArchive({ save = true } = {}) {
    if (!archive || archiveFinalized) return;
    archiveFinalized = true;
    try {
      await runZip(async () => {
        if (zip?.entryOpen) await zip.abortEntry();
        if (completedEntries > 0) await zip.finish();
      });
      if (completedEntries > 0) {
        if (save) await archiveTarget.save();
        else await archiveTarget.discard();
      } else {
        await archiveTarget.discard();
      }
    } catch (err) {
      notice(`压缩包保存失败：${err.message}`, 'danger');
      await archiveTarget?.discard().catch(() => {});
    }
  }

  async function finishReceive() {
    if (finished || stopped) return;
    finished = true;
    state.finished = true;
    await finalizeArchive({ save: true });
    progress.value = 100;
    if (archive) {
      transferText.textContent = `${completedEntries} 个文件已打包`;
      setTransferStatus('压缩包已保存，可继续选择其他文件。', 'ok');
    } else {
      transferText.textContent = `${wanted.length} 个文件已接收`;
      setTransferStatus('本轮下载完成，可继续选择其他文件。', 'ok');
    }
    state.controls.setState(CONTROL.DONE);
    teardownRound();
  }

  async function failReceive(message) {
    if (finished || stopped) return;
    finished = true;
    state.finished = true;
    await finalizeArchive({ save: true });
    transferText.textContent = message;
    state.controls.setState(CONTROL.ERROR);
    setTransferStatus(message, 'danger');
    teardownRound();
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
    currentFile = null;
    if (!sink) return;
    try {
      await sink.cleanup?.();
    } catch {
      // 清理失败不影响停止流程
    }
  }

  function stopReceiver() {
    if (stopped || finished) return;
    stopped = true;
    finished = true;
    state.finished = true;
    paused = false;
    wakePause();
    relayAbort?.abort();
    state.controls.setState(CONTROL.STOPPED);
    setTransferStatus(archive ? '正在保存已完成的文件…' : '正在停止…');
    // 不向发送方发 stop：直连可以连续下载多个文件，按“本轮结束”处理即可
    void (async () => {
      await cleanupCurrentSink();
      await finalizeArchive({ save: true });
      const status = archive
        ? (completedEntries > 0
          ? `已停止，${completedEntries} 个已完成文件已保存到压缩包。`
          : '已停止，未收到完整文件。')
        : '已停止本次下载，可继续选择其他文件。';
      setTransferStatus(status, 'warn');
      teardownRound();
    })();
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
    if (payload.action === 'ask') {
      sendSelect();
      return;
    }
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
      stopReceiver();
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
        }
      },
      onPeerLeft: () => {
        if (!finished && !stopped) {
          transferText.textContent = '发送方离开了，请让他重新打开分享页面。';
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
    stop: () => stopReceiver(),
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
        if (!wantedSet.has(message.idx) || completedSet.has(message.idx)) return;
        const file = byIdx.get(message.idx);
        if (!file) return;
        if (currentSink) await cleanupCurrentSink();
        if (finished || stopped) return;
        currentFile = file;
        currentSink = await makeSink(message.idx, currentFile);
        if (finished || stopped) {
          await cleanupCurrentSink();
          return;
        }
        transferText.textContent = `正在接收 ${file.relPath}…`;
      } else if (message.k === 'end') {
        if (!wantedSet.has(message.idx) || completedSet.has(message.idx)) return;
        // 先摘下当前文件的引用，避免关闭旧 sink 的异步过程被下一个文件打断。
        const sink = currentSink;
        const file = currentFile;
        currentSink = null;
        currentFile = null;
        await finishSink(message.idx, file, sink);
        completedSet.add(message.idx);
        completedFiles += 1;
        // 直连没有额外的结束信号，按本轮要接收的文件数判断是否完成
        if (completedFiles >= wanted.length) await finishReceive();
      }
      return;
    }

    const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!currentSink || !currentFile) return;
    await currentSink.write(chunk);
    receivedBytes += chunk.byteLength;
    showProgress(receivedBytes);
  }

  /** 打开当前文件的写入端：直连单文件用内存，整包写入 zip 条目 */
  async function makeSink(idx, file) {
    if (!archive) return createMemorySink();
    if (archiveFinalized) return createDiscardSink();
    if (zip.entryOpen) await runZip(() => zip.abortEntry());
    await runZip(() => zip.beginEntry({
      name: entryNames.get(idx) ?? file.name,
      size: file.size,
      mtimeMs: Date.now(),
    }));
    let ended = false;
    return {
      kind: 'zip',
      async write(chunk) {
        if (ended || archiveFinalized) return;
        await runZip(() => zip.writeChunk(chunk));
      },
      async close() {
        if (ended) return;
        ended = true;
        if (archiveFinalized) return;
        await runZip(async () => {
          await zip.endEntry();
          completedEntries += 1;
        });
      },
      async cleanup() {
        if (ended) return;
        ended = true;
        if (archiveFinalized) return;
        await runZip(() => zip.abortEntry());
      },
    };
  }

  /** 已完成的文件在切中继后还会被发送方重发一次，用丢弃 sink 消费掉，避免 zip 里出现重复条目 */
  function createDiscardSink() {
    return {
      kind: 'discard',
      async write() {},
      async close() {},
      async cleanup() {},
    };
  }

  async function finishSink(idx, file, sink) {
    if (!file) return;
    if (archive) {
      await sink?.close?.();
      return;
    }
    if (sink?.kind === 'memory') {
      saveBlob(sink.toBlob(file.mime || 'application/octet-stream'), file.name);
    }
  }

  async function makeRelaySink(file) {
    return makeSink(file.idx, file);
  }

  async function receiveViaRelay() {
    mode = 'relay';
    transferStarted = true;
    relayRunning = true;
    completedFiles = completedSet.size;
    receivedBytes = wantedFiles
      .filter((file) => completedSet.has(file.idx))
      .reduce((sum, file) => sum + file.size, 0);
    showProgress(receivedBytes);
    state.controls.setState(CONTROL.RUNNING, { allowPause: true });
    transferText.textContent = '正在接收…';

    for (const idx of wanted) {
      const file = byIdx.get(idx);
      if (!file) continue;
      const alreadyDone = completedSet.has(idx);
      let done = false;
      let retries = 0;

      while (!done) {
        await waitIfPaused();
        if (finished || stopped) return;
        relayAbort = new AbortController();
        let sink = null;

        try {
          sink = alreadyDone ? createDiscardSink() : await makeRelaySink(file);
          if (finished || stopped) {
            await sink.cleanup?.();
            return;
          }
          currentSink = sink;
          currentFile = file;
          const base = receivedBytes;

          const result = await readViaRelay({
            shareId: share.id,
            idx,
            token: state.token,
            sink,
            totalHint: file.size,
            signal: relayAbort.signal,
            onProgress: alreadyDone ? () => {} : (received) => showProgress(base + received),
          });

          if (finished || stopped) return;
          if (!alreadyDone) {
            if (!archive && sink.kind === 'memory') {
              saveBlob(sink.toBlob(file.mime || 'application/octet-stream'), file.name);
            }
            receivedBytes = base + result.received;
            completedSet.add(idx);
            completedFiles += 1;
            showProgress(receivedBytes);
          }
          currentSink = null;
          currentFile = null;
          sendControl('file-done', { idx });
          done = true;
        } catch (err) {
          if (finished || stopped) return;
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
          await failReceive(`「${file.relPath}」接收失败：${err.message}`);
          return;
        }
      }
    }

    relayRunning = false;
    if (!finished && !stopped) await finishReceive();
  }
  signaling.ready
    .then(({ peers }) => {
      // 无论发送方在不在，都先报一次本轮要哪几个文件；发送方连接后也会再问一次
      sendSelect();
      if (finished || stopped || transferStarted) return;
      if (peers.some((role) => role === 'sender' || role === 'upload')) {
        transferText.textContent = '发送方已连接，正在建立传输…';
      } else {
        transferText.textContent = '正在等待发送方打开页面…';
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
