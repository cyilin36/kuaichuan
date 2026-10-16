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

  // 前端需要的公开配置（不含任何密钥）
  router.get('/api/config', (req, res) => {
    sendJson(res, 200, {
      appName: config.appName,
      version: config.version,
      defaultTtlHours: config.defaultTtlHours,
      maxTtlHours: config.maxTtlHours,
      maxFileBytes: config.maxFileBytes,
      maxTextBytes: config.maxTextBytes,
      relayEnabled: config.relayEnabled,
      passwordLength: 4,
    });
  });
}
