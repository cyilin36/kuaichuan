/**
 * 内存中继：把发送方的上传流直接接到接收方的下载流上。
 *
 * ⚠️ 本文件禁止出现任何 fs / node:fs 调用——这是「P2P 兜底也不落盘」的保证点，
 *    数据只经过内存与 socket 缓冲区。
 *
 * 配对模型：先到的一方挂在 pending 里等（此时不读它的请求体，靠 TCP 背压让发送端
 * 停在「等待接收方接入」），后到的一方把它叫醒，由先到的一方负责架管道。
 */

import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppError, payloadTooLarge, relayTimeout } from '../errors.js';

export function relayKey(...parts) {
  return parts.map((part) => String(part ?? '')).join('|');
}

export function createRelayBridge({ config, logger }) {
  /** key -> { side, ctx, settle, fail, timer } */
  const pending = new Map();
  const active = new Set();

  const isWaiting = (key) => pending.has(key);
  const hasPendingFor = (shareId) => {
    const prefix = `${shareId}|`;
    for (const key of pending.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  };

  /** 客户端断开时把等待中的挂起项清掉 */
  function abort(key) {
    const entry = pending.get(key);
    if (!entry) return false;
    entry.fail(new AppError('client_gone', 499, '对方已断开连接'));
    return true;
  }

  /**
   * 参与一次配对。
   * @returns {Promise<null | { side: string, ctx: object }>}
   *   返回 null 表示「你已经是被叫醒的一方，等对端把数据写完即可」
   */
  async function pair(key, side, ctx) {
    if (!config.relayEnabled) {
      throw new AppError('relay_disabled', 503, '服务器当前无法转交内容，请稍后重试');
    }
    if (active.size >= config.relayMaxSessions) {
      throw new AppError('relay_busy', 503, '服务器同时传输的任务太多，请稍后再试');
    }

    const entry = pending.get(key);
    if (entry) {
      pending.delete(key);
      entry.settle({ side, ctx });
      return null;
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        reject(relayTimeout());
      }, config.relayWaitSeconds * 1000);
      timer.unref?.();

      pending.set(key, {
        side,
        ctx,
        settle: (peer) => {
          clearTimeout(timer);
          resolve(peer);
        },
        fail: (err) => {
          clearTimeout(timer);
          pending.delete(key);
          reject(err);
        },
      });
    });
  }

  /**
   * 架管道：upload.req -> download.res，全程不落盘。
   * 传输错误在这里消化掉，不往外抛（此时响应头多半已经发出去了）。
   */
  async function connect({
    key, upload, download, maxBytes = 0, contentType = 'application/octet-stream', headers = {},
  }) {
    active.add(key);
    let bytes = 0;

    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        if (maxBytes > 0 && bytes + chunk.length > maxBytes) {
          callback(payloadTooLarge(`内容不能超过 ${maxBytes} 字节`));
          return;
        }
        bytes += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      download.res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });

      await pipeline(upload.req, counter, download.res);

      if (!upload.res.headersSent) {
        upload.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      upload.res.end(JSON.stringify({ ok: true, bytes }));
      logger?.info('内存中继完成', { key, bytes });

      return { ok: true, bytes };
    } catch (err) {
      if (!download.res.writableEnded) download.res.destroy();
      const status = err instanceof AppError ? err.httpStatus : 502;
      if (!upload.res.headersSent) {
        upload.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      if (!upload.res.writableEnded) {
        upload.res.end(JSON.stringify({
          ok: false,
          error: err instanceof AppError ? err.code : 'relay_failed',
          message: err?.message ?? '中继传输失败',
          bytes,
        }));
      }
      logger?.warn('内存中继中断', { key, bytes, message: err?.message ?? String(err) });
      return { ok: false, bytes, error: err };
    } finally {
      active.delete(key);
    }
  }

  return {
    pair,
    connect,
    abort,
    isWaiting,
    hasPendingFor,
    /** 同时进行的传输数 */
    activeCount: () => active.size,
    /** 等待对端接入的传输数 */
    pendingCount: () => pending.size,
  };
}
