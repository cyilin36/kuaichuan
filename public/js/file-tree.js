/**
 * 文件列表的目录树：把扁平的文件按相对路径整理成「文件夹行 + 文件行」。
 *
 * 输出是排好序的扁平数组，depth 表示缩进层级，顺序渲染即可；
 * 文件夹行带 indices（该文件夹下所有文件的分享内序号），用于整夹下载。
 */

const compareName = (a, b) => String(a.name).localeCompare(
  String(b.name),
  undefined,
  { numeric: true, sensitivity: 'base' },
);

function makeNode(path, name, depth) {
  return {
    path, name, depth, folders: new Map(), files: [], size: 0, count: 0,
  };
}

/** 去掉 basePath 前缀，得到相对保存目录的路径；不在其下时原样返回 */
export function stripBase(relPath, basePath = '') {
  const path = String(relPath ?? '');
  if (!basePath) return path;
  const prefix = `${basePath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** 这组文件里是否存在文件夹（相对路径带层级） */
export function hasFolders(files) {
  return files.some((file) => String(file.relPath ?? '').split('/').filter(Boolean).length > 1);
}

/**
 * 校验并整理「要下载哪些文件」的序号：去重、过滤越界与非法值、升序。
 * 接收方和发送方各校验一次，避免对端传来奇怪的序号。
 */
export function normalizeIndices(indices, length) {
  if (!Array.isArray(indices)) return [];
  const total = Number(length) || 0;
  return [...new Set(indices.map((value) => Number(value)))]
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < total)
    .sort((a, b) => a - b);
}

export function buildFileRows(files) {
  const root = makeNode('', '', 0);

  for (const file of files) {
    const parts = String(file.relPath ?? '').split('/').filter(Boolean);
    const name = parts.pop() ?? String(file.name ?? 'file');
    let node = root;
    for (const part of parts) {
      let child = node.folders.get(part);
      if (!child) {
        child = makeNode(node.path ? `${node.path}/${part}` : part, part, node.depth + 1);
        node.folders.set(part, child);
      }
      node = child;
    }
    node.files.push({ ...file, name });
  }

  const measure = (node) => {
    let size = node.files.reduce((sum, file) => sum + Number(file.size ?? 0), 0);
    let count = node.files.length;
    for (const folder of node.folders.values()) {
      const child = measure(folder);
      size += child.size;
      count += child.count;
    }
    node.size = size;
    node.count = count;
    return { size, count };
  };
  measure(root);

  const sorted = (node) => ({
    folders: [...node.folders.values()].sort(compareName),
    files: [...node.files].sort(compareName),
  });

  const collectIndices = (node) => {
    const indices = [];
    const visit = (current) => {
      const { folders, files: nodeFiles } = sorted(current);
      for (const folder of folders) visit(folder);
      for (const file of nodeFiles) {
        if (Number.isInteger(file.idx)) indices.push(file.idx);
      }
    };
    visit(node);
    return indices.sort((a, b) => a - b);
  };

  const rows = [];
  const emit = (node) => {
    const { folders, files: nodeFiles } = sorted(node);
    for (const folder of folders) {
      rows.push({
        type: 'folder',
        path: folder.path,
        name: folder.name,
        depth: folder.depth - 1,
        size: folder.size,
        count: folder.count,
        indices: collectIndices(folder),
      });
      emit(folder);
    }
    for (const file of nodeFiles) {
      rows.push({
        type: 'file',
        idx: file.idx,
        path: file.relPath,
        name: file.name,
        depth: node.depth,
        size: Number(file.size ?? 0),
      });
    }
  };
  emit(root);

  return rows;
}

/**
 * 按折叠状态过滤树行：文件夹收起后，它的所有后代行都不再渲染。
 *
 * rows 必须是 buildFileRows 的输出（深度优先，depth 可以逐级回溯）。
 *
 * @param {Array} rows buildFileRows 的结果
 * @param {Set<string>} collapsed 已收起的文件夹路径集合
 */
export function visibleRows(rows, collapsed = new Set()) {
  const visible = [];
  const ancestors = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    // 回到同一层级：把已经结束的兄弟与后代移出栈
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= row.depth) {
      ancestors.pop();
    }
    if (!ancestors.some((entry) => entry.collapsed)) visible.push(row);
    ancestors.push({
      depth: row.depth,
      collapsed: row.type === 'folder' && collapsed.has(row.path),
    });
  }
  return visible;
}
