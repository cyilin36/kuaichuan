/**
 * 响应辅助：统一 JSON 结构与错误输出。
 */

import { AppError, internal } from '../errors.js';

export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendText(res, status, text, { contentType = 'text/plain; charset=utf-8', headers = {} } = {}) {
  if (res.writableEnded || res.destroyed) return;
  const payload = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function sendNoContent(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/**
 * 统一错误出口：AppError 按状态码返回，其他异常一律 500 且只把堆栈写日志。
 */
export function sendError(res, err, logger, context = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof AppError) {
    if (err.httpStatus >= 500) {
      logger?.error('请求处理失败', { code: err.code, message: err.message, ...context });
    } else {
      logger?.debug('请求被拒绝', { code: err.code, message: err.message, ...context });
    }
    sendJson(res, err.httpStatus, err.toBody());
    return;
  }
  logger?.error('未预期的异常', {
    message: err?.message ?? String(err),
    stack: err?.stack,
    ...context,
  });
  const fallback = internal();
  sendJson(res, fallback.httpStatus, fallback.toBody());
}
