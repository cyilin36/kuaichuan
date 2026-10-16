// P0 阶段的引导脚本：确认前后端连通。P6 会替换为完整界面。

const status = document.getElementById('boot-status');

try {
  const res = await fetch('/healthz', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  status.className = 'muted ok';
  status.textContent = `服务正常：${data.name} v${data.version}（数据目录 ${data.dataDir}）`;
} catch (err) {
  status.className = 'muted danger';
  status.textContent = `无法连接服务：${err.message}`;
}
