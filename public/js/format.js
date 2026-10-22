/** 展示用的格式化工具。 */

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 || index === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[index]}`;
}

export function formatRemaining(expiresAt, now = Date.now()) {
  const ms = Number(expiresAt) - now;
  if (!Number.isFinite(ms)) return '未知';
  if (ms <= 0) return '已过期';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `剩余 ${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `剩余 ${hours} 小时`;
  return `剩余 ${Math.floor(hours / 24)} 天`;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatEta(remainingBytes, bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  const seconds = Math.ceil(remainingBytes / bytesPerSecond);
  if (seconds < 60) return `约 ${seconds} 秒`;
  if (seconds < 3600) return `约 ${Math.ceil(seconds / 60)} 分钟`;
  return `约 ${Math.ceil(seconds / 3600)} 小时`;
}

export function describeKind(kind) {
  return kind === 'text' ? '文字' : '文件';
}

export function describeMode(mode) {
  return mode === 'p2p' ? '直接传输' : '先上传到服务器';
}

/** 进度文案 */
export function describeProgress({ sent, total, startedAt }) {
  const elapsed = Math.max(0.2, (Date.now() - startedAt) / 1000);
  const speed = sent / elapsed;
  const percent = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  return `${percent.toFixed(0)}%（${formatBytes(sent)} / ${formatBytes(total)}）${formatSpeed(speed)} ${formatEta(total - sent, speed)}`.trim();
}
