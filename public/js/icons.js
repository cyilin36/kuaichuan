/**
 * 目录树行首的文件夹 / 文件图标。
 *
 * 内联 SVG，无外部资源；用 DOM API 逐个创建，禁止 innerHTML 插入任何标记。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function createIcon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'row-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** 文件夹：闭合的文件夹轮廓 */
export function folderIcon() {
  return createIcon([
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ]);
}

/** 文件：带折角的文档轮廓 */
export function fileIcon() {
  return createIcon([
    'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z',
    'M14 2v4a2 2 0 0 0 2 2h4',
  ]);
}
