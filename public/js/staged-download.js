/**
 * 暂存下载控制器：Range 断点续传 + 暂停/继续/停止。
 *
 * 暂停时关闭写入流并保留 offset；继续时用 If-Range + Range 从断点重新请求。
 * 服务器返回 200（文件版本变化或不支持 Range）时自动从头重下。
 */

import { describeProgress } from './format.js';
import {
  createFileSystemSink, createMemorySink, saveBlob,
} from './transport.js';
import { CONTROL } from './transfer-control.js';

const RETRY_LIMIT = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createStagedDownloader({
  share, token, files, directoryHandle, progress, transferText, controls, onStatus, onNotice,
}) {
  const total = files.reduce((sum, item) => sum + item.size, 0);

  let running = false;
  let paused = false;
  let stopped = false;
  let runPromise = null;
  let sink = null;
  let abortController = null;
  let completedBytes = 0;
  let resumeIndex = 0;
  let startedAt = Date.now();
  let current = { idx: 0, offset: 0, etag: null };
  let progressTimer = null;
  const pauseWaiters = new Set();

  const wakePause = () => {
    for (const resolve of pauseWaiters) resolve();
    pauseWaiters.clear();
  };

  const updateProgress = () => {
    progress.hidden = false;
    const skipped = files.slice(0, current.idx).reduce((sum, item) => sum + item.size, 0);
    const done = Math.max(completedBytes, skipped) + current.offset;
    const sent = Math.min(total, done);
    progress.value = total > 0 ? (sent / total) * 100 : 100;
    transferText.textContent = describeProgress({ sent, total, startedAt });
  };

  const closeSink = async () => {
    const old = sink;
    sink = null;
    if (!old) return;
    try {
      await old.close();
    } catch {
      // 关闭失败不影响后续重开
    }
  };

  // 暂停/重试时内存模式必须保留已收数据，FSA 模式则关闭写入流把数据刷到磁盘
  const closeForInterruption = async () => {
    if (sink?.kind === 'memory') return;
    await closeSink();
  };

  const cleanupSink = async () => {
    const old = sink;
    sink = null;
    if (!old) return;
    try {
      await old.cleanup();
    } catch {
      // 清理失败只能留给用户自行删除
    }
  };

  /**
   * 打开目标文件的写入流。offset>0 时要求保留已有部分；
   * 浏览器无法续写时退化为从头下载（会提示一次）。
   */
  async function ensureSink(item, offset) {
    if (sink?.kind === 'memory') {
      if (offset === 0) {
        sink.reset();
        return 0;
      }
      if (sink.offset === offset) return offset;
      const error = new Error('内存中缺少已下载部分');
      error.code = 'need_restart';
      throw error;
    }

    await closeSink();

    if (offset > 0) {
      if (!directoryHandle) {
        const error = new Error('缺少未完成的本地文件');
        error.code = 'need_restart';
        throw error;
      }
      try {
        sink = await createFileSystemSink({
          directoryHandle,
          relativePath: item.relPath,
          offset,
        });
        return offset;
      } catch {
        onNotice?.('当前浏览器无法从断点续写，正在重新下载该文件。', 'warn');
        const error = new Error('无法从断点续写');
        error.code = 'need_restart';
        throw error;
      }
    }

    if (!directoryHandle) {
      sink = createMemorySink();
      return 0;
    }

    try {
      sink = await createFileSystemSink({
        directoryHandle,
        relativePath: item.relPath,
        offset: 0,
      });
      return 0;
    } catch {
      onNotice?.('写入所选文件夹失败，文件将保存到浏览器下载目录。', 'warn');
      sink = createMemorySink();
      return 0;
    }
  }

  async function fetchFile(item) {
    if (current.offset > 0 && current.etag) {
      // 每次请求都新建 controller，暂停时只中止当前请求
      abortController = new AbortController();
    } else {
      abortController = new AbortController();
    }

    const headers = { authorization: `Bearer ${token}` };
    if (current.offset > 0) {
      headers.Range = `bytes=${current.offset}-`;
      if (current.etag) headers['If-Range'] = current.etag;
    }

    let response;
    try {
      response = await fetch(`/api/shares/${share.id}/files/${item.idx}`, {
        headers,
        signal: abortController.signal,
      });
    } catch (err) {
      if (abortController.signal.aborted) return { status: 'paused' };
      throw err;
    }

    if (response.status === 416) {
      const error = new Error('文件已变化，请重新下载。');
      error.code = 'changed';
      throw error;
    }

    if (!response.ok) {
      let message = '下载失败，请稍后重试。';
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

    if (response.status === 200) {
      // 不是 206：说明服务端返回了完整文件，必须从头写，避免把两段拼在一起
      if (current.offset > 0) {
        onNotice?.('文件已变化，正在从头重新下载。', 'warn');
      }
      current.offset = 0;
    }

    const etag = response.headers.get('etag');
    if (etag) current.etag = etag;

    try {
      current.offset = await ensureSink(item, current.offset);
    } catch (err) {
      if (err.code === 'need_restart') {
        current.offset = 0;
        try {
          await response.body?.cancel();
        } catch {
          // 忽略取消失败
        }
        return { status: 'restart' };
      }
      throw err;
    }
    updateProgress();

    const reader = response.body.getReader();
    try {
      for (;;) {
        if (stopped) return { status: 'stopped' };
        if (paused) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!sink) return { status: 'stopped' };
        await sink.write(value);
        current.offset += value.byteLength;
        updateProgress();
      }
    } catch (err) {
      if (stopped) return { status: 'stopped' };
      if (abortController.signal.aborted || err?.name === 'AbortError') {
        await closeForInterruption();
        return { status: 'paused' };
      }
      await closeForInterruption();
      const error = new Error('下载中断，正在从断点重试…');
      error.code = 'network';
      throw error;
    }

    if (paused && !stopped) {
      await closeForInterruption();
      return { status: 'paused' };
    }

    if (current.offset < item.size) {
      await closeForInterruption();
      const error = new Error('连接提前结束');
      error.code = 'network';
      throw error;
    }

    // 完成：内存模式落成浏览器下载，FSA 模式关闭写入流
    const finished = sink;
    sink = null;
    if (finished?.kind === 'memory') {
      saveBlob(finished.toBlob(item.mime || 'application/octet-stream'), item.name);
    } else {
      await finished?.close();
    }

    return { status: 'done' };
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
    controls.setState(CONTROL.PAUSED);
    onStatus('已暂停，可点击「继续」从断点接着下载。', 'warn');
    while (paused && !stopped) {
      await new Promise((resolve) => pauseWaiters.add(resolve));
    }
    throwIfStopped();
    controls.setState(CONTROL.RUNNING, { allowPause: true });
    onStatus('正在继续下载…');
  }

  async function run() {
    running = true;
    paused = false;
    startedAt = Date.now();
    completedBytes = files.slice(0, resumeIndex).reduce((sum, item) => sum + item.size, 0);
    controls.setState(CONTROL.RUNNING, { allowPause: true });
    onStatus('正在下载…');
    updateProgress();

    progressTimer = setInterval(updateProgress, 500);

    try {
      for (let idx = resumeIndex; idx < files.length; idx += 1) {
        throwIfStopped();
        await waitIfPaused();

        const item = files[idx];
        current = { idx, offset: 0, etag: null };
        updateProgress();

        let retries = 0;
        for (;;) {
          throwIfStopped();
          await waitIfPaused();

          try {
            const outcome = await fetchFile(item);
            if (outcome.status === 'stopped') return;
            if (outcome.status === 'restart') {
              await closeSink();
              continue;
            }
            if (outcome.status === 'paused') {
              await waitIfPaused();
              continue;
            }
            completedBytes += item.size;
            current.offset = item.size;
            updateProgress();
            break;
          } catch (err) {
            if (stopped) return;
            await closeForInterruption();
            if (err.code === 'changed') throw err;
            if (err.status === 409 && retries < 5) {
              retries += 1;
              await sleep(250 * retries);
              continue;
            }
            if ((err.code === 'network' || err.status >= 500) && retries < RETRY_LIMIT) {
              retries += 1;
              onStatus(`下载中断，正在从断点重试（${retries}/${RETRY_LIMIT}）…`, 'warn');
              await sleep(400 * retries);
              continue;
            }
            throw err;
          }
        }
      }

      if (stopped) return;
      controls.setState(CONTROL.DONE);
      progress.value = 100;
      transferText.textContent = `全部 ${files.length} 个文件已保存`;
      onStatus('下载完成。', 'ok');
    } catch (err) {
      if (stopped) return;
      if (err.status === 401 || err.status === 403 || err.status === 404 || err.status === 410
        || err.code === 'changed') {
        controls.setState(CONTROL.ERROR);
        onStatus(`下载失败：${err.message}`, 'danger');
        return;
      }
      resumeIndex = current.idx;
      completedBytes = files.slice(0, resumeIndex).reduce((sum, item) => sum + item.size, 0);
      paused = true;
      runPromise = null;
      controls.setState(CONTROL.PAUSED);
      onStatus(`下载中断：${err.message}。可点击「继续」从断点重试。`, 'warn');
    } finally {
      running = false;
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
      }
      if (stopped) await cleanupSink();
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
      if (abortController) {
        abortController.abort();
      } else {
        controls.setState(CONTROL.PAUSED);
        onStatus('已暂停，可点击「继续」从断点接着下载。', 'warn');
      }
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      wakePause();
      if (!running) {
        controls.setState(CONTROL.RUNNING, { allowPause: true });
        onStatus('正在继续下载…');
        runPromise = run();
        return;
      }
      controls.setState(CONTROL.RUNNING, { allowPause: true });
      onStatus('正在继续下载…');
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      paused = false;
      wakePause();
      controls.setState(CONTROL.STOPPING);
      onStatus('正在停止…');
      abortController?.abort();
      await cleanupSink();
      controls.setState(CONTROL.STOPPED);
      updateProgress();
      onStatus('已停止。未完成的部分已停止，已完成的文件保留。', 'warn');
    },
  };
}
