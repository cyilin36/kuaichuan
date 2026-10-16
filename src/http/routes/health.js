/**
 * 健康检查。
 */

import { sendJson } from '../respond.js';

const startedAt = Date.now();

export function registerHealthRoutes(router, { config, services = {} }) {
  router.get('/healthz', (req, res) => {
    const stats = services.stats?.() ?? { shares: 0, bytes: 0 };
    sendJson(res, 200, {
      ok: true,
      name: config.appName,
      version: config.version,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      dataDir: config.dataDir,
      relay: config.relayEnabled,
      staged: stats,
    });
  });
}
