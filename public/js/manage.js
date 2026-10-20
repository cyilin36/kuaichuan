/**
 * 「我的分享」：数据全部来自本机 localStorage，凭 owner 令牌向服务器查状态或撤销。
 */

import { apiJson, listLocalShares, loadPublicConfig, removeLocalShare } from './api.js';
import { describeKind, describeMode, formatBytes, formatRemaining } from './format.js';

const $ = (id) => document.getElementById(id);

function setStatus(text, tone = '') {
  const el = $('status');
  el.className = `muted ${tone}`;
  el.textContent = text;
}

function pill(text, tone = '') {
  const span = document.createElement('span');
  span.className = `pill ${tone}`;
  span.textContent = text;
  return span;
}

async function revoke(record, onDone) {
  try {
    await apiJson(`/api/shares/${record.id}`, { method: 'DELETE', token: record.ownerToken });
    removeLocalShare(record.id);
    onDone('已作废，服务器上的内容也已删除。');
  } catch (err) {
    if (err.status === 404 || err.status === 410) {
      removeLocalShare(record.id);
      onDone('这个分享本来就已经失效了，已从本机记录里移除。');
      return;
    }
    onDone(`作废失败：${err.message}`);
  }
}

async function renderItem(record) {
  const wrapper = document.createElement('div');
  wrapper.className = 'manage-item';

  // Drag Handle Illusion：悬停时左侧 ⋮⋮ 淡入（仅装饰，不进无障碍树）
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.setAttribute('aria-hidden', 'true');
  handle.textContent = '⋮⋮';

  const info = document.createElement('div');
  info.className = 'info';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = record.title || record.id;

  const meta = document.createElement('div');
  meta.className = 'muted small';
  meta.textContent = [
    describeKind(record.kind),
    describeMode(record.mode),
    record.files?.length ? `${record.files.length} 个文件` : null,
    record.totalBytes ? formatBytes(record.totalBytes) : null,
  ].filter(Boolean).join(' · ');

  const stateLine = document.createElement('div');
  stateLine.className = 'muted small';
  stateLine.textContent = '正在查询状态…';

  const linkRow = document.createElement('div');
  linkRow.className = 'row share-links';

  const link = document.createElement('a');
  link.className = 'mono small';
  link.href = record.url ?? `/s/${record.id}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = record.url ?? `/s/${record.id}`;
  linkRow.append(link);

  if (record.password) {
    const passwordTag = document.createElement('code');
    passwordTag.className = 'small';
    passwordTag.textContent = `密码 ${record.password}`;
    linkRow.append(passwordTag);

    const copyButton = document.createElement('button');
    copyButton.className = 'tiny';
    copyButton.textContent = '复制链接和密码';
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard?.writeText(`${link.textContent}\n密码：${record.password}`);
      copyButton.textContent = '已复制 ✓';
    });
    linkRow.append(copyButton);
  }

  const actions = document.createElement('div');
  actions.className = 'row';

  const revokeButton = document.createElement('button');
  revokeButton.className = 'tiny danger';
  revokeButton.textContent = '立即作废';
  revokeButton.addEventListener('click', () => {
    revokeButton.disabled = true;
    revoke(record, (message) => {
      stateLine.textContent = message;
      stateLine.className = 'small ok';
      wrapper.remove();
    });
  });

  const forgetButton = document.createElement('button');
  forgetButton.className = 'tiny';
  forgetButton.textContent = '仅删除本机记录';
  forgetButton.addEventListener('click', () => {
    removeLocalShare(record.id);
    wrapper.remove();
  });

  actions.append(revokeButton, forgetButton);
  info.append(title, meta, stateLine, linkRow);
  wrapper.append(handle, info, actions);

  // 查询真实状态
  try {
    const metaData = await apiJson(`/api/shares/${record.id}`, { token: record.ownerToken });
    const bits = [
      formatRemaining(metaData.expiresAt),
      `已被取走 ${metaData.downloads} 次`,
    ];
    if (metaData.maxDownloads) bits.push(`上限 ${metaData.maxDownloads} 次`);
    if (metaData.burnAfterRead) bits.push('阅后即焚');
    if (metaData.mode === 'p2p') bits.push(metaData.senderOnline ? '发送方在线' : '发送方离线');
    stateLine.textContent = bits.join(' · ');
    stateLine.className = 'muted small';

    if (metaData.mode === 'p2p') {
      title.append(' ', pill('需要保持页面打开', 'p2p'));
    }
    title.append(' ', pill(metaData.status === 'active' ? '可用' : '等待中', 'live'));
  } catch (err) {
    if (err.status === 404 || err.status === 410) {
      stateLine.textContent = err.status === 410 ? '已失效（过期或被作废）' : '服务器上已不存在';
      stateLine.className = 'small danger';
      title.append(' ', pill('已失效', 'dead'));
      revokeButton.disabled = true;
      revokeButton.textContent = '已失效';
    } else {
      stateLine.textContent = `状态查询失败：${err.message}`;
      stateLine.className = 'small danger';
    }
  }

  return wrapper;
}

async function init() {
  const config = await loadPublicConfig();
  $('app-name').textContent = config.appName;
  document.title = `我的分享 · ${config.appName}`;

  const shares = listLocalShares();
  if (shares.length === 0) {
    setStatus('本机还没有分享记录。去首页创建一个吧。');
    return;
  }

  $('list-card').hidden = false;
  $('bulk-actions').hidden = false;
  $('clear-all').addEventListener('click', () => {
    if (!window.confirm('只清空本机记录，服务器上的分享仍然存在。确定吗？')) return;
    for (const record of listLocalShares()) removeLocalShare(record.id);
    $('list').replaceChildren();
    setStatus('本机记录已清空。');
  });

  const list = $('list');
  for (const record of shares) {
    list.append(await renderItem(record));
  }

  setStatus(`共 ${shares.length} 条本机记录。`);
}

init().catch((err) => setStatus(`初始化失败：${err.message}`, 'danger'));
