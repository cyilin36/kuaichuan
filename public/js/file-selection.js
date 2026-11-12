/**
 * 创建页的文件选择：多次选择累加，而不是每次覆盖。
 *
 * 浏览器不提供绝对路径，只能按「相对路径 + 大小 + 修改时间」启发式判断是不是同一个文件：
 *   - 同一个文件再选一次：跳过，列表不出现重复项。
 *   - 相对路径相同但内容不同（例如文件改过又选了一次）：把文件名编成「名称 (2).ext」，
 *     保证列表与压缩包里的条目仍然唯一。
 *   - 判定依据相同的两个不同文件会被当成重复，属于可接受的启发式取舍。
 *
 * 这里只负责展示用的相对路径，服务端仍会按其长度与字符规则再校验一次。
 */

/** 与服务端 MAX_FILES_PER_SHARE 保持一致；创建页以 /api/config 返回的值为准。 */
export const MAX_FILES_PER_SHARE = 500;

const KEY_SEP = '\u0000';

function sourceIdentity(relPath, size, lastModified) {
  return `${relPath}${KEY_SEP}${size}${KEY_SEP}${lastModified}`;
}

function toItem(file, fromDirectory) {
  const name = String(file?.name ?? '') || 'file';
  const size = Number(file?.size ?? 0) || 0;
  const lastModified = Number(file?.lastModified ?? 0) || 0;
  const relative = fromDirectory ? String(file?.webkitRelativePath ?? '') : '';
  const relPath = relative || name;
  return {
    file,
    relPath,
    name,
    size,
    mime: file?.type || 'application/octet-stream',
    lastModified,
    // 改名后 relPath 会变，身份键必须单独保存，否则再次选择同一批文件无法去重
    sourceKey: sourceIdentity(relPath, size, lastModified),
  };
}

/** 同一个文件的判定依据；优先用入列表时的原始身份 */
function identity(item) {
  return item.sourceKey || sourceIdentity(item.relPath, item.size, item.lastModified);
}

/** 只改文件名，保留所在目录 */
function renamePath(relPath, name) {
  const slash = relPath.lastIndexOf('/');
  return slash < 0 ? name : `${relPath.slice(0, slash + 1)}${name}`;
}

function numberedName(name, index) {
  const dot = name.lastIndexOf('.');
  // 没有扩展名或点开头的隐藏文件，序号补在末尾
  if (dot <= 0) return `${name} (${index})`;
  return `${name.slice(0, dot)} (${index})${name.slice(dot)}`;
}

/**
 * 把本次选中的文件追加到已选列表。
 *
 * @param {Array} existing 已选列表（不会被修改）
 * @param {Iterable} picked 本次选择得到的 File 列表
 * @param {{ fromDirectory?: boolean, maxFiles?: number }} options
 * @returns {{ files: Array, added: number, duplicates: number, overflow: number, renamed: number, limit: number }}
 */
export function appendFiles(existing, picked, { fromDirectory = false, maxFiles } = {}) {
  const limit = Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : MAX_FILES_PER_SHARE;
  const files = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(files.map(identity));
  const paths = new Set(files.map((item) => item.relPath));
  let added = 0;
  let duplicates = 0;
  let overflow = 0;
  let renamed = 0;

  for (const file of picked ?? []) {
    const item = toItem(file, fromDirectory);
    const key = identity(item);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    if (files.length >= limit) {
      overflow += 1;
      continue;
    }
    if (paths.has(item.relPath)) {
      // 路径冲突：从小序号开始找一个没被占用的文件名
      for (let index = 2; ; index += 1) {
        const candidateName = numberedName(item.name, index);
        const candidate = renamePath(item.relPath, candidateName);
        if (!paths.has(candidate)) {
          item.name = candidateName;
          item.relPath = candidate;
          renamed += 1;
          break;
        }
      }
    }
    files.push(item);
    // 用改名前的身份登记，之后再次选择同一文件仍能识别为重复
    seen.add(key);
    paths.add(item.relPath);
    added += 1;
  }

  return {
    files, added, duplicates, overflow, renamed, limit,
  };
}
