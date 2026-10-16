/**
 * 候选访问地址：让发送方自己挑一个内嵌进链接与二维码。
 *
 * 场景：在家里用 localhost 打开页面，但要把链接给手机用，
 * 这时必须用局域网地址，否则对方打不开。
 */

import os from 'node:os';

import { sendJson } from '../respond.js';
import { normalizeOrigin } from '../../domain/shares.js';

export function registerNetworkRoutes(router, { config }) {
  router.get('/api/network', (req, res) => {
    const host = req.headers.host ?? '';
    const scheme = req.socket?.encrypted ? 'https' : 'http';
    const portFromHost = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '';
    const port = portFromHost || String(config.port);

    const candidates = [];
    const push = (url, label) => {
      const normalized = normalizeOrigin(url);
      if (normalized && !candidates.some((item) => item.url === normalized)) {
        candidates.push({ url: normalized, label });
      }
    };

    if (config.baseUrl) push(config.baseUrl, '配置的 BASE_URL');
    if (host) push(`${scheme}://${host}`, '当前访问的地址');

    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          push(`${scheme}://${addr.address}:${port}`, `局域网（${name}）`);
        }
      }
    }

    push(`${scheme}://localhost:${port}`, '仅本机可用');

    sendJson(res, 200, { candidates, configured: config.baseUrl || null });
  });
}
