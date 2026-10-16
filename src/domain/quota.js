/**
 * 暂存配额：纯选择逻辑，不做任何 I/O。
 * 具体删除动作交给 domain/lifecycle.js，避免循环依赖。
 */

/**
 * @param {{ id: string, created_at: number, total_bytes: number }[]} rows 已按创建时间升序
 * @param {{ incomingBytes: number, maxTotalBytes: number, usedBytes: number, protect?: Set<string> }} options
 * @returns {{ evict: string[], feasible: boolean, freeAfterEvict: number }}
 */
export function selectEvictions(rows, { incomingBytes, maxTotalBytes, usedBytes, protect = new Set() }) {
  if (maxTotalBytes <= 0) {
    return { evict: [], feasible: true, freeAfterEvict: Number.POSITIVE_INFINITY };
  }

  let free = maxTotalBytes - usedBytes;
  const evict = [];

  for (const row of rows) {
    if (free >= incomingBytes) break;
    if (protect.has(row.id)) continue;
    evict.push(row.id);
    free += Number(row.total_bytes ?? 0);
  }

  return { evict, feasible: free >= incomingBytes, freeAfterEvict: free };
}

/** 总配额是否可以完全容纳（不清理任何东西） */
export function fitsWithoutEviction({ usedBytes, incomingBytes, maxTotalBytes }) {
  if (maxTotalBytes <= 0) return true;
  return usedBytes + incomingBytes <= maxTotalBytes;
}
