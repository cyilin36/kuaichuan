/**
 * 健康检查。
 */

import { sendJson } from '../respond.js';
import { MAX_FILES_PER_SHARE } from '../../domain/shares.js';

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
      maxP2pFileBytes: config.maxP2pFileBytes,
      maxStagedFileBytes: config.maxStagedFileBytes,
      maxTextBytes: config.maxTextBytes,
      maxFilesPerShare: MAX_FILES_PER_SHARE,
      relayEnabled: config.relayEnabled,
      passwordLength: 4,
    });
  });
}
