/**
 * 文字分享的取件接口。
 *
 * 文字内容不随元数据返回，统一走这里：计次、阅后即焚都在这一步处理。
 * 暂存文字已经在内存里，所以可以「先销毁再发送」——不存在文件那种交付竞态。
 * 具体语义在 domain/text.js，AI 接口也复用同一份实现。
 */

import { sendText } from '../respond.js';
import { contentDisposition } from '../download.js';
import { assertShareAvailable, getShareRow, requireViewer } from '../../domain/shares.js';
import { extractToken } from '../../domain/tokens.js';
import { readStagedText } from '../../domain/text.js';

export function registerTextRoutes(router, { logger, services }) {
  const { db, locations, tokenSecret } = services;

  router.get('/api/shares/:id/text', async (req, res, { params, url }) => {
    const share = getShareRow(db, params.id);
    requireViewer({ tokenSecret, share, token: extractToken(req, url) });
    assertShareAvailable(share);

    const { text } = await readStagedText({ db, locations, logger, share });
    const fileName = `${share.title || share.id}.txt`;

    sendText(res, 200, text, {
      headers: { 'Content-Disposition': contentDisposition(fileName) },
    });
  });
}
