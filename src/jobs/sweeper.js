/**
 * 定时清理器：过期释放磁盘、清理撤销记录、执行配额、清理审计事件与孤儿目录。
 *
 * 要求：幂等、串行（同一时刻只跑一次）、失败不影响主服务。
 */

import { pruneEvents } from '../storage/shares.repo.js';
import {
  EVENT_RETENTION_MS,
  expireDue,
  purgeExpired,
  purgeOrphanDirs,
  purgeRevoked,
} from '../domain/lifecycle.js';

/**
 * @param {{ db: object, locations: object, logger: object, config: object }} deps
 */
export function createSweeper({ db, locations, logger, config }) {
  let running = false;

  const tick = async () => {
    if (running) return null;
    running = true;
    try {
      return await runSweep({ db, locations, logger });
    } catch (err) {
      logger?.error('清理任务失败', { message: err?.message ?? String(err) });
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, config.sweepSeconds * 1000);
  timer.unref?.();

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}

export async function runSweep({ db, locations, logger, now = Date.now() }) {
  const expired = await expireDue({ db, locations, logger, now });
  const purgedExpired = purgeExpired({ db, now });
  const purgedRevoked = purgeRevoked({ db, now });
  const prunedEvents = pruneEvents(db, now - EVENT_RETENTION_MS);
  const orphans = await purgeOrphanDirs({ db, locations, logger });

  const summary = {
    expired,
    purgedExpired,
    purgedRevoked,
    prunedEvents,
    orphans: orphans.length,
  };

  const touched = expired + purgedExpired + purgedRevoked + prunedEvents + orphans.length;
  if (touched > 0) logger?.info('清理完成', summary);

  return summary;
}
