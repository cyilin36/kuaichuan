/**
 * 极简路由：支持 :param 段，够用且零依赖。
 */

import path from 'node:path';
import { ROOT } from '../paths.js';
import { notFound } from '../errors.js';
import { sendError } from './respond.js';
import { serveStatic } from './static.js';
import { registerRoutes } from './routes/index.js';

function splitPattern(pattern) {
  return String(pattern)
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (s.startsWith(':') ? { name: s.slice(1) } : { literal: s }));
}

function matchSegments(segments, parts) {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.literal !== undefined) {
      if (seg.literal !== parts[i]) return null;
    } else {
      let value = parts[i];
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
      params[seg.name] = value;
    }
  }
  return params;
}

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler) => {
    routes.push({ method, pattern, segments: splitPattern(pattern), handler });
  };

  return {
    get: (p, h) => add('GET', p, h),
    head: (p, h) => add('HEAD', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const parts = pathname.split('/').filter((s) => s !== '');
      for (const route of routes) {
        if (route.method !== method) continue;
        const params = matchSegments(route.segments, parts);
        if (params) return { handler: route.handler, params };
      }
      return null;
    },
    get routes() {
      return routes.slice();
    },
  };
}

/**
 * 组装 HTTP 应用：API 路由优先，其次静态资源，最后 404。
 *
 * @param {{ config: object, logger: object, services?: object }} deps
 */
export function createApp({ config, logger, services = {} }) {
  const router = createRouter();
  registerRoutes(router, { config, logger, services });

  const handler = async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      // 用真实的 Host 构造 URL：分享链接要按访问地址生成，不能用占位主机名
      const scheme = req.socket?.encrypted ? 'https' : 'http';
      let url;
      try {
        url = new URL(req.url ?? '/', `${scheme}://${req.headers.host ?? 'localhost'}`);
      } catch {
        url = new URL(req.url ?? '/', `http://localhost:${config.port}`);
      }
      // 只记 pathname，绝不记 query（可能含 token）
      pathname = url.pathname;

      const hit = router.match(req.method, pathname);
      if (hit) {
        await hit.handler(req, res, { params: hit.params, url });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, {
          publicDir: config.publicDir ?? path.join(ROOT, 'public'),
          pathname,
        });
        if (!served) throw notFound('页面不存在');
      } else {
        throw notFound('接口不存在');
      }
    } catch (err) {
      sendError(res, err, logger, { method: req.method, path: pathname });
    } finally {
      logger.debug('请求完成', {
        method: req.method,
        path: pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  };

  return { handler, router };
}

export { splitPattern, matchSegments };
