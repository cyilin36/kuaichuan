/**
 * 传输层。
 *
 * 一条分享只由发送方选一条路，并通过信令广播出去，接收方服从——
 * 避免两边各选一条路互相死等。
 *
 *   PATH.WEBRTC：浏览器之间直连（DataChannel）
 *   PATH.RELAY ：服务器内存转发（全程不落盘）
 */

export const PATH = { WEBRTC: 'webrtc', RELAY: 'relay' };
export const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;
const ICE_TIMEOUT_MS = 8000;
const CHANNEL_TIMEOUT_MS = 12_000;

export function supportsDirectoryPicker() {
  return typeof window.showDirectoryPicker === 'function';
}

// --------------------------------------------------------------------------
// 信令
// --------------------------------------------------------------------------

export function createSignaling({ shareId, role, token, handlers = {} }) {
  const url = new URL('/ws', window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('share', shareId);
  url.searchParams.set('role', role);
  url.searchParams.set('t', token);

  const socket = new WebSocket(url);
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(() => readyReject(new Error('信令连接超时')), 10_000);

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message.t) {
      case 'ready':
        clearTimeout(timer);
        readyResolve({ peers: message.peers ?? [] });
        break;
      case 'peer-joined':
        handlers.onPeerJoined?.(message.role);
        break;
      case 'peer-left':
        handlers.onPeerLeft?.(message.role);
        break;
      case 'signal':
        handlers.onPayload?.(message.payload, message.from);
        break;
      case 'error':
        handlers.onError?.(message);
        break;
      default:
        break;
    }
  });

  socket.addEventListener('error', () => {
    clearTimeout(timer);
    readyReject(new Error('信令连接失败'));
  });

  socket.addEventListener('close', () => {
    clearTimeout(timer);
    handlers.onClose?.();
  });

  return {
    ready,
    send(payload) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'signal', payload }));
      }
    },
    close() {
      try {
        socket.close();
      } catch {
        // 忽略
      }
    },
  };
}

// --------------------------------------------------------------------------
// WebRTC
// --------------------------------------------------------------------------

export class RtcPeer {
  constructor({ iceServers, role, handlers = {} }) {
    this.role = role;
    this.handlers = handlers;
    this.channel = null;
    this.pendingCandidates = [];
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) handlers.onCandidate?.(event.candidate.toJSON());
    });
    this.pc.addEventListener('connectionstatechange', () => {
      handlers.onState?.(this.pc.connectionState);
      if (this.pc.connectionState === 'failed') handlers.onFailed?.(this.pc.connectionState);
    });

    if (role === 'sender') {
      this._wire(this.pc.createDataChannel('data', { ordered: true }));
    } else {
      this.pc.addEventListener('datachannel', (event) => this._wire(event.channel));
    }
  }

  _wire(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.addEventListener('open', () => this.handlers.onOpen?.());
    channel.addEventListener('close', () => this.handlers.onClose?.());
    channel.addEventListener('error', () => this.handlers.onError?.(new Error('数据通道异常')));
    channel.addEventListener('message', (event) => this.handlers.onData?.(event.data));
  }

  get isChannelOpen() {
    return this.channel?.readyState === 'open';
  }

  /** 等待数据通道打开；超时抛错，由调用方决定是否降级 */
  waitForChannel(timeoutMs = CHANNEL_TIMEOUT_MS) {
    if (this.isChannelOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channel?.removeEventListener('open', onOpen);
        reject(new Error('数据通道建立超时'));
      }, timeoutMs);
      function onOpen() {
        clearTimeout(timer);
        resolve();
      }
      if (!this.channel) {
        clearTimeout(timer);
        reject(new Error('数据通道未创建'));
        return;
      }
      this.channel.addEventListener('open', onOpen, { once: true });
    });
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription;
  }

  async handleSignal(payload) {
    if (payload?.k === 'sdp') {
      await this.pc.setRemoteDescription(payload.sdp);
      await this._flushCandidates();
      if (payload.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        return this.pc.localDescription;
      }
      return null;
    }
    if (payload?.k === 'candidate') {
      if (this.pc.remoteDescription) {
        await this.pc.addIceCandidate(payload.candidate).catch(() => {});
      } else {
        this.pendingCandidates.push(payload.candidate);
      }
    }
    return null;
  }

  async _flushCandidates() {
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  /** 发送一块数据，必要时等待缓冲区回落 */
  async send(buffer) {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') throw new Error('数据通道未就绪');
    if (channel.bufferedAmount > HIGH_WATER) {
      await new Promise((resolve) => {
        const onLow = () => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
        setTimeout(onLow, 2000);
      });
    }
    channel.send(buffer);
  }

  sendControl(object) {
    return this.send(JSON.stringify(object));
  }

  async sendFile(file, { idx, onProgress } = {}) {
    await this.sendControl({ k: 'file', idx, size: file.size, type: file.type || '' });
    let sent = 0;
    while (sent < file.size) {
      const slice = file.slice(sent, Math.min(sent + CHUNK_SIZE, file.size));
      const buffer = await slice.arrayBuffer();
      await this.send(buffer);
      sent += buffer.byteLength;
      onProgress?.(sent, file.size);
    }
    await this.sendControl({ k: 'end', idx });
    return sent;
  }

  close() {
    try {
      this.channel?.close();
    } catch {
      // 忽略
    }
    try {
      this.pc.close();
    } catch {
      // 忽略
    }
  }
}

export { ICE_TIMEOUT_MS, CHANNEL_TIMEOUT_MS };

// --------------------------------------------------------------------------
// 内存中继（服务器转发，不落盘）
// --------------------------------------------------------------------------

export function postViaRelay({ shareId, idx, token, body, onProgress, contentType = 'application/octet-stream' }) {
  const suffix = idx === undefined ? 'text' : `f/${idx}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/relay/${shareId}/${suffix}`);
    xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.setRequestHeader('content-type', contentType);

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded, event.total || 0));
    }
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
      const error = new Error(data?.message ?? `中继发送失败（HTTP ${xhr.status}）`);
      error.status = xhr.status;
      reject(error);
    });
    xhr.addEventListener('error', () => reject(new Error('中继发送失败：网络错误')));
    xhr.addEventListener('abort', () => reject(new Error('已取消')));
    xhr.send(body);
  });
}

export function getViaRelayUrl({ shareId, idx, token }) {
  const suffix = idx === undefined ? 'text' : `f/${idx}`;
  return `/api/relay/${shareId}/${suffix}?t=${encodeURIComponent(token)}`;
}

export async function readViaRelay({ shareId, idx, token, sink, onProgress, totalHint = 0 }) {
  const response = await fetch(getViaRelayUrl({ shareId, idx, token }));
  if (!response.ok) {
    let message = `取件失败（HTTP ${response.status}）`;
    try {
      const data = await response.json();
      message = data?.message ?? message;
    } catch {
      // 忽略
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  const total = Number(response.headers.get('content-length') ?? 0) || totalHint;
  const reader = response.body.getReader();
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (sink) await sink.write(value);
    onProgress?.(received, total);
  }
  if (sink) await sink.close();
  return { received, contentType: response.headers.get('content-type') ?? '' };
}

// --------------------------------------------------------------------------
// 接收端落盘：优先 File System Access API，退化为内存 Blob
// --------------------------------------------------------------------------

export function createMemorySink() {
  const chunks = [];
  let size = 0;
  return {
    kind: 'memory',
    async write(value) {
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy);
      size += copy.byteLength;
    },
    async close() {},
    get size() {
      return size;
    },
    toBlob(type = 'application/octet-stream') {
      return new Blob(chunks, { type });
    },
  };
}

export async function createFileSystemSink({ directoryHandle, relativePath }) {
  const parts = String(relativePath).split('/').filter(Boolean);
  const fileName = parts.pop() ?? 'file';
  let directory = directoryHandle;
  for (const part of parts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  return {
    kind: 'fs',
    async write(value) {
      await writable.write(value);
    },
    async close() {
      await writable.close();
    },
  };
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 让浏览器直接下载某个接口地址（暂存模式用） */
export async function downloadUrl(url, fileName) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`下载失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  saveBlob(blob, fileName);
}

/** 暂存模式：直接流式落盘（有 FSA 时写目录，否则走下载） */
export async function downloadToSink({ url, sink }) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`下载失败（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    await sink.write(value);
  }
  await sink.close();
  return received;
}
