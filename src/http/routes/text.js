/**
 * 文字分享的取件接口。
 *
 * 文字内容不随元数据返回，统一走这里：计次、阅后即焚都在这一步处理。
 * 暂存文字已经在内存里，所以可以「先销毁再发送」——不存在文件那种交付竞态。
 */

import { badRequest, conflict, gone } from '../../errors.js';
import { sendText } from '../respond.js';
import { contentDisposition } from '../download.js';
import { incrementDownloads, recordEvent } from '../../storage/shares.repo.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { purgeShare } from '../../domain/lifecycle.js';

export function registerTextRoutes(router, { logger, services }) {
  const { db, locations, tokenSecret } = services;

  router.get('/api/shares/:id/text', async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    if (share.kind !== 'text') throw badRequest('该分享不是文字分享');
    if (share.mode !== 'staged') {
      throw conflict('该分享的内容不经过服务器，请在分享页面中查看');
    }
    if (share.textContent === null || share.textContent === undefined) {
      throw gone('文字内容已被取走或已销毁');
    }

    const text = share.textContent;
    const fileName = `${share.title || share.id}.txt`;

    // 计数与销毁都在发送之前完成（内容已在内存，不存在丢数据风险）
    incrementDownloads(db, share.id);
    recordEvent(db, 'download', { shareId: share.id });

    if (share.burnAfterRead) {
      await purgeShare({ db, locations, id: share.id, reason: 'burn' });
      logger?.info('阅后即焚：文字分享已销毁', { id: share.id });
    }

    sendText(res, 200, text, {
      headers: { 'Content-Disposition': contentDisposition(fileName) },
    });
  });
}
