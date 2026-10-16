#!/usr/bin/env node
/**
 * 服务入口：只做装配与生命周期管理，业务逻辑在 src/ 各模块里。
 */

import http from 'node:http';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { ensureDirs } from './paths.js';
import { createApp } from './http/router.js';
import { openDatabase, closeDatabase } from './storage/db.js';
import { loadTokenSecret } from './storage/secret.js';
import { createSweeper } from './jobs/sweeper.js';
import { createRelayBridge } from './realtime/relay-bridge.js';
import { createPresence } from './realtime/presence.js';
import { attachWebSocket } from './realtime/ws.js';
import { stats } from './domain/lifecycle.js';

export async function main() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    file: config.logFile,
    locations: config.locations,
  });

  await ensureDirs(config.locations);

  const db = openDatabase(config.locations, { logger });
  const tokenSecret = await loadTokenSecret(config);

  const bridge = createRelayBridge({ config, logger });
  const presence = createPresence({ bridge });

  const services = {
    db,
    tokenSecret,
    locations: config.locations,
    bridge,
    presence,
    stats: () => stats(db),
  };

  const app = createApp({ config, logger, services });
  const server = http.createServer(app.handler);
  const realtime = attachWebSocket({ server, config, logger, services });

  // 大文件上传/下载与内存中继都是长连接，不设整体超时，只保留头部超时。
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const sweeper = createSweeper({ db, locations: config.locations, logger, config });
  await sweeper.tick();

  const { port } = server.address();
  logger.info('服务已启动', {
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`,
    dataDir: config.dataDir,
    relay: config.relayEnabled,
    defaultTtlHours: config.defaultTtlHours,
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info('收到退出信号，正在关闭', { signal });
    sweeper.stop();
    realtime.close();
    server.close(() => {
      closeDatabase(db);
      logger.close();
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabase(db);
      process.exit(0);
    }, 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return { server, config, logger, db, sweeper };
}

main().catch((err) => {
  process.stderr.write(`启动失败：${err?.message ?? err}\n${err?.stack ?? ''}\n`);
  process.exit(1);
});
