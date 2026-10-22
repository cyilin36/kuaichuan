/**
 * 暂存上传控制器：断点续传 + 暂停/继续/停止。
 *
 * 服务器以 .part 的实际大小为准，所以每次续传前都先查 GET …/upload，
 * 中断时以服务器进度回填，避免浏览器进度事件与真实落盘不一致。
 */

import { describeProgress, formatBytes } from './format.js';
import { CONTROL } from './transfer-control.js';

const RETRY_LIMIT = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createStagedUploader({ share, files, progress, progressText, controls, onStatus }) {
  const total = files.reduce((sum, item) => sum + item.size, 0);

  let running = false;
  let paused = false;
  let stopped = false;
  let runPromise = null;
  let currentXhr = null;
  let completedBytes = 0;
  let startedAt = Date.now();
  let current = { idx: 0, offset: 0, loaded: 0 };
  const pauseWaiters = new Set();

  const wakePause = () => {
    for (const resolve of pauseWaiters) resolve();
    pauseWaiters.clear();
  };

  const updateProgress = () => {
    progress.hidden = false;
    const sent = Math.min(total, completedBytes + current.offset + current.loaded);
    progress.value = total > 0 ? (sent / total) * 100 : 100;
    progressText.textContent = describeProgress({ sent, total, startedAt });
  };

  const fetchStatus = async (idx) => {
    const res = await fetch(`/api/shares/${share.id}/files/${idx}/upload`, {
      headers: { authorization: `Bearer ${share.ownerToken}` },
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = new Error(data?.message ?? '读取上传进度失败，请稍后重试。');
      error.status = res.status;
      throw error;
    }
    return data;
  };

  const uploadChunk = ({ idx, offset, file }) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/shares/${share.id}/files/${idx}`);
    xhr.setRequestHeader('authorization', `Bearer ${share.ownerToken}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (offset > 0) xhr.setRequestHeader('upload-offset', String(offset));

    currentXhr = xhr;
    const clear = () => {
      if (currentXhr === xhr) currentXhr = null;
    };

    xhr.upload.addEventListener('progress', (event) => {
      current.loaded = event.loaded;
      updateProgress();
    });
    xhr.addEventListener('load', () => {
      clear();
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
      const error = new Error(data?.message ?? '上传失败，请稍后重试。');
      error.status = xhr.status;
      error.code = data?.error;
      reject(error);
    });
    xhr.addEventListener('error', () => {
      clear();
      const error = new Error('上传失败：网络错误');
      error.code = 'network';
      reject(error);
    });
    xhr.addEventListener('abort', () => {
      clear();
      const error = new Error('已暂停');
      error.code = 'aborted';
      reject(error);
    });
    xhr.send(file.slice(offset));
  });

  const cancelUpload = async (idx) => {
    await fetch(`/api/shares/${share.id}/files/${idx}/upload`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${share.ownerToken}` },
    });
  };

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
    controls.setState(CONTROL.PAUSED);
    onStatus('已暂停，可点击「继续」从断点接着上传。', 'warn');
    while (paused && !stopped) {
      await new Promise((resolve) => pauseWaiters.add(resolve));
    }
    throwIfStopped();
    controls.setState(CONTROL.RUNNING, { allowPause: true });
    onStatus('正在继续上传…');
  }

  async function waitForServerOffset(idx, fallback) {
    try {
      const status = await fetchStatus(idx);
      return Math.max(0, Number(status.received) || 0);
    } catch {
      return fallback;
    }
  }

  async function run() {
    running = true;
    paused = false;
    startedAt = Date.now();
    completedBytes = 0;
    controls.setState(CONTROL.RUNNING, { allowPause: true });
    onStatus('正在上传…');
    updateProgress();

    try {
      for (let idx = 0; idx < files.length; idx += 1) {
        throwIfStopped();
        await waitIfPaused();

        const item = files[idx];
        current = { idx, offset: 0, loaded: 0 };

        const status = await fetchStatus(idx);
        if (status.complete) {
          completedBytes += item.size;
          updateProgress();
          continue;
        }

        let offset = Math.max(0, Number(status.received) || 0);
        let retries = 0;

        for (;;) {
          throwIfStopped();
          await waitIfPaused();

          current.offset = offset;
          current.loaded = 0;
          updateProgress();

          try {
            const result = await uploadChunk({ idx, offset, file: item.file });
            offset = Math.max(offset, Number(result.received) || 0);
            current.offset = offset;
            current.loaded = 0;
            updateProgress();
            retries = 0;

            if (result.complete) {
              completedBytes += item.size;
              updateProgress();
              break;
            }
          } catch (err) {
            if (stopped) return;
            if (err.code === 'aborted') {
              // 暂停/停止会中止 XHR；停止已在上面返回，这里按暂停处理
              await waitIfPaused();
              offset = await waitForServerOffset(idx, offset);
              continue;
            }
            if (err.status === 409 || err.status === 400) {
              offset = await waitForServerOffset(idx, offset);
              continue;
            }
            if ((err.code === 'network' || err.status >= 500) && retries < RETRY_LIMIT) {
              retries += 1;
              onStatus(`上传中断，正在从断点重试（${retries}/${RETRY_LIMIT}）…`, 'warn');
              await sleep(400 * retries);
              offset = await waitForServerOffset(idx, offset);
              continue;
            }
            throw err;
          }
        }
      }

      if (stopped) return;
      controls.setState(CONTROL.DONE);
      progress.value = 100;
      progressText.textContent = `已上传 ${formatBytes(total)}`;
      onStatus('上传完成，可以关闭本页面了。', 'ok');
    } catch (err) {
      if (stopped) return;
      if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 410) {
        controls.setState(CONTROL.ERROR);
        onStatus(`上传失败：${err.message}`, 'danger');
        return;
      }
      // 其他中断保持可继续：重新开始 run 时会先查询服务器断点
      paused = true;
      runPromise = null;
      controls.setState(CONTROL.PAUSED);
      onStatus(`上传中断：${err.message}。可点击「继续」从断点重试。`, 'warn');
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (runPromise) return runPromise;
      runPromise = run();
      return runPromise;
    },
    pause() {
      if (!running || paused || stopped) return;
      paused = true;
      controls.setState(CONTROL.PAUSING);
      onStatus('正在暂停…');
      if (currentXhr) {
        currentXhr.abort();
      } else {
        controls.setState(CONTROL.PAUSED);
        onStatus('已暂停，可点击「继续」从断点接着上传。', 'warn');
      }
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      wakePause();
      if (!running) {
        controls.setState(CONTROL.RUNNING, { allowPause: true });
        onStatus('正在继续上传…');
        runPromise = run();
        return;
      }
      controls.setState(CONTROL.RUNNING, { allowPause: true });
      onStatus('正在继续上传…');
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      paused = false;
      wakePause();
      controls.setState(CONTROL.STOPPING);
      onStatus('正在停止…');
      currentXhr?.abort();
      try {
        await cancelUpload(current.idx ?? 0);
      } catch {
        // 网络失败时服务端分片会随分享过期清理
      }
      controls.setState(CONTROL.STOPPED);
      progressText.textContent = `已上传 ${formatBytes(completedBytes)}`;
      onStatus('已停止。已上传完成的文件仍可通过链接下载。', 'warn');
    },
  };
}
