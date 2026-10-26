/**
 * 接收页的文件列表：把扁平的文件按相对路径整理成「文件夹行 + 文件行」。
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
