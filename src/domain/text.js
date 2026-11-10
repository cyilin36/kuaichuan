/**
 * 文字分享的取件领域逻辑。
 *
 * 网页（GET /api/shares/:id/text）与 AI 接口（POST /api/agent/v1/text/:id/read）
 * 必须走同一套语义：取件即计次、阅后即焚在发送前销毁。抽到这里避免两条路径行为漂移。
 */

import { badRequest, conflict, gone } from '../errors.js';
import { incrementDownloads, recordEvent } from '../storage/shares.repo.js';
import { purgeShare } from './lifecycle.js';

/**
 * 读取暂存文字分享的内容，并完成计次 / 焚毁。
 *
 * 文字内容已在内存，所以可以「先销毁再返回」——不存在文件交付那种竞态。
 *
 * @returns {Promise<{ text: string, burned: boolean }>}
 */
export async function readStagedText({ db, locations, logger, share }) {
  if (share.kind !== 'text') throw badRequest('该分享不是文字分享');
  if (share.mode !== 'staged') {
    throw conflict('该分享的内容不经过服务器，请在分享页面中查看');
  }
  if (share.textContent === null || share.textContent === undefined) {
    throw gone('文字内容已被取走或已销毁');
  }

  const text = share.textContent;
  const burned = Boolean(share.burnAfterRead);

  // 计数与销毁都在返回之前完成（内容已在内存，不存在丢数据风险）
  incrementDownloads(db, share.id);
  recordEvent(db, 'download', { shareId: share.id });

  if (burned) {
    await purgeShare({ db, locations, id: share.id, reason: 'burn' });
    logger?.info('阅后即焚：文字分享已销毁', { id: share.id });
  }

  return { text, burned };
}
