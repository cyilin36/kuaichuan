/**
 * 静态资源托管（无构建前端）。
 *
 * 只允许白名单后缀，且任何路径都要通过 isContained 校验，防止目录穿越。
 */

import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { isContained } from '../paths.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const ALLOWED_EXT = new Set(Object.keys(MIME));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

/** 页面路由 -> 实际 html 文件 */
function resolveTarget(publicDir, pathname) {
  if (pathname === '/' || pathname === '/index.html') return path.join(publicDir, 'index.html');
  if (pathname === '/manage' || pathname === '/manage/') return path.join(publicDir, 'manage.html');

  // 分享页：ID 的合法性由 API 判定，页面本身统一渲染，避免用户看到光秃秃的 404。
  if (/^\/s\/[A-Za-z0-9]{1,64}\/?$/.test(pathname)) {
    return path.join(publicDir, 's.html');
  }

  if (pathname.startsWith('/api/') || pathname === '/ws' || pathname === '/healthz') return null;

  const rel = pathname.replace(/^\/+/, '');
  if (rel === '') return null;

  const abs = path.resolve(publicDir, rel);
  if (!isContained(publicDir, abs)) return null;
  if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) return null;
  return abs;
}

/**
 * @returns {Promise<boolean>} 是否已处理该请求
 */
export async function serveStatic(req, res, { publicDir, pathname }) {
  const abs = resolveTarget(publicDir, pathname);
  if (!abs || !isContained(publicDir, abs)) return false;

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(abs).toLowerCase();
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;

  const baseHeaders = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    res.end();
    return true;
  }

  res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve) => {
    const stream = createReadStream(abs);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('close', resolve);
    stream.pipe(res);
  });
  return true;
}

export { CSP, MIME };
