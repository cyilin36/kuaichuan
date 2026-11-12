#!/usr/bin/env node
/**
 * 快传（kuaichuan）Skill CLI。
 *
 * 让 AI Agent 像用户用网页一样使用快传：
 *   - 发送：把文字或文件（目录递归展开）创建成「链接 + 4 位密码」，交给接收方远程取件；
 *   - 接收：读取分享链接里的文字，或把文件下载到本地。
 *
 * 设计约束（详见仓库 .tmp/agent-contract.md 第 4 节）：
 *   - 零第三方依赖，只用 node: 内置模块与全局 fetch，Node ≥ 20 / 24 均可运行；
 *   - 成功时 stdout 只输出一个 JSON（recv --text 输出正文原文）；
 *   - 出错时 stderr 输出一行 {"error":"…","message":"…"}，退出码 1；用法错误退出码 2；
 *   - 绝不打印 KUAICHUAN_API_KEY；创建成功必须把 password 交给调用方；
 *   - 暂存上传走流式（createReadStream + fetch duplex:'half'），失败按 Upload-Offset 断点续传；
 *   - P2P 发送默认后台（detached 子进程 + 日志/状态文件），接收端对中继 504/499 做重试。
 *
 * 本地状态目录默认为当前目录下 ./.kuaichuan（0700/0600、原子写），
 * 可通过 --state-dir 或 KUAICHUAN_STATE_DIR 覆盖；CLI 不会在状态目录外写文件
 * （recv 下载的文件写到 --out 指定目录，属显式交付位置）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本地状态文件结构版本；格式变化时递增，避免旧版本悄悄读错。 */
const STATE_VERSION = 1;
/** 暂存上传的默认重试窗口（秒）。 */
const DEFAULT_STAGED_TIMEOUT_SECONDS = 600;
/** P2P 发送默认后台等待时长（秒）。 */
const DEFAULT_P2P_TIMEOUT_SECONDS = 1800;
/** 接收 P2P 内容的默认等待时长（秒）。 */
const DEFAULT_RECV_TIMEOUT_SECONDS = 600;
/** 普通 JSON 接口的请求超时。 */
const DEFAULT_API_TIMEOUT_MS = 30_000;
/** 失败重试间隔：P2P 靠服务端挂起等待对端，客户端只需短暂退避。 */
const RETRY_DELAY_MS = 1000;
/** 分享 ID：服务端允许 4~32 位 base62，与 src/paths.js 的 assertShareId 保持一致。 */
const SHARE_ID_RE = /^[A-Za-z0-9]{4,32}$/;

const HELP_TEXT = `快传 Skill CLI（零依赖 ESM，Node >= 20）

用法：
  kuaichuan.mjs <命令> [参数...]

命令：
  setup --url <服务地址> [--key <API Key>]
      校验服务端 AI 接入是否可用，成功后才写入配置文件。
  info
      查看服务信息、限制与可用端点。
  send-text [<文字>] [--text <文字>] [--file <路径>] [--stdin]
            [--title <标题>] [--no-password] [--ttl <小时>]
            [--max-downloads <次数>] [--burn] [--mode staged|p2p]
            [--foreground] [--timeout <秒>]
  send-file <路径...> [--title <标题>] [--no-password] [--ttl <小时>]
            [--max-downloads <次数>] [--burn] [--mode staged|p2p]
            [--foreground] [--timeout <秒>]
      文件或目录都可以；目录会递归展开并保留相对路径。
  recv <链接|ID> [--password <密码>] [--out <目录>] [--info] [--text]
       [--overwrite] [--json] [--timeout <秒>]
      --text 把文字正文原样打印到 stdout；--info 只看元数据。
  list [--all]
      列出本机创建过的分享；默认省略已过期/已撤销（--all 保留）。
  status <链接|ID>
  revoke <链接|ID> [--owner-token <令牌>]

全局参数：
  --url <地址>         覆盖服务地址（优先级最高）
  --key <API Key>      覆盖 API Key
  --state-dir <目录>   本地状态目录（默认 ./.kuaichuan）
  --config <路径>      配置文件路径
  --help               显示本帮助

环境变量：
  KUAICHUAN_URL / KUAICHUAN_API_KEY / KUAICHUAN_PASSWORD /
  KUAICHUAN_STATE_DIR / KUAICHUAN_CONFIG

输出与退出码：
  - 成功时 stdout 输出单个 JSON；recv --text 例外，直接输出正文原文。
  - 出错时 stderr 输出 {"error":"…","message":"…"}，退出码 1；用法错误退出码 2。
  - 分享创建成功会输出 url 与 4 位 password，请把这两项交给接收人。
  - --mode p2p 默认后台发送，额外输出 background/pid/log；发送方需保持进程在线。
`;

// ---------------------------------------------------------------------------
// 错误与通用小工具
// ---------------------------------------------------------------------------

class CliError extends Error {
  /**
   * @param {string} code 机器可读错误码（尽量沿用服务端约定）
   * @param {string} message 面向用户的中文提示
   * @param {{ exitCode?: number, httpStatus?: number|null, retryable?: boolean }} [options]
   */
  constructor(code, message, { exitCode = 1, httpStatus = null, retryable = false } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

/** 用法错误：退出码 2，与运行时错误区分开。 */
function usageError(message) {
  return new CliError('usage', message, { exitCode: 2 });
}

function notConfiguredError(message = '还没有配置快传服务地址，请先运行：kuaichuan.mjs setup --url <服务地址>') {
  return new CliError('not_configured', message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMaybeJson(text) {
  if (text === undefined || text === null || text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 成功输出：stdout 只允许出现一个 JSON。 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function remainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

function attemptTimeout(deadline) {
  return remainingMs(deadline);
}

function assertBeforeDeadline(deadline, message) {
  if (Date.now() >= deadline) throw new CliError('relay_timeout', message);
}

/** 请求释放的文件句柄；Windows 上先删再 rename 才不会失败。 */
async function removeFileQuietly(file) {
  try {
    await fsp.rm(file, { force: true });
  } catch {
    // 清理失败不掩盖真实错误
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

/** 所有命令都可用的取值参数。 */
const COMMON_VALUE_FLAGS = ['url', 'key', 'config', 'state-dir'];

/** 每个命令自己的取值参数、开关参数与位置参数数量。 */
const COMMAND_SPECS = {
  setup: { values: ['url', 'key'], bools: [], positionals: [0, 0] },
  help: { values: [], bools: [], positionals: [0, 0] },
  info: { values: [], bools: [], positionals: [0, 0] },
  'send-text': {
    values: ['text', 'file', 'title', 'ttl', 'max-downloads', 'mode', 'timeout'],
    bools: ['stdin', 'no-password', 'burn', 'foreground'],
    positionals: [0, Number.POSITIVE_INFINITY],
  },
  'send-file': {
    values: ['title', 'ttl', 'max-downloads', 'mode', 'timeout'],
    bools: ['no-password', 'burn', 'foreground'],
    positionals: [1, Number.POSITIVE_INFINITY],
  },
  recv: {
    values: ['password', 'out', 'timeout'],
    bools: ['info', 'text', 'overwrite', 'json'],
    positionals: [1, 1],
  },
  list: { values: [], bools: ['all'], positionals: [0, 0] },
  status: { values: [], bools: [], positionals: [1, 1] },
  revoke: { values: ['owner-token'], bools: [], positionals: [1, 1] },
  '__relay-send': { values: ['id', 'timeout'], bools: [], positionals: [0, 0] },
};

function positionalMessage(command, min, max) {
  if (min === max) return `${command} 需要 ${min} 个位置参数`;
  if (max === Number.POSITIVE_INFINITY) return `${command} 至少需要 ${min} 个位置参数`;
  return `${command} 需要 ${min}~${max} 个位置参数`;
}

/**
 * 手写参数解析：支持 --flag value、--flag=value、布尔开关与 `--` 之后的位置参数。
 * 命令必须是第一个参数（便于人类与 Agent 都直观）。
 */
function parseArgv(argv) {
  let command = null;
  let rest = argv;
  if (argv.length > 0 && !String(argv[0]).startsWith('-')) {
    command = String(argv[0]);
    rest = argv.slice(1);
  }

  if (command !== null && !Object.prototype.hasOwnProperty.call(COMMAND_SPECS, command)) {
    throw usageError(`未知命令：${command}（运行 --help 查看可用命令）`);
  }
  const spec = command === null ? null : COMMAND_SPECS[command];
  const valueFlags = new Set([...COMMON_VALUE_FLAGS, ...(spec?.values ?? [])]);
  const boolFlags = new Set(spec?.bools ?? []);

  const flags = Object.create(null);
  const positionals = [];
  let endOfOptions = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = String(rest[i]);
    if (endOfOptions) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      flags.version = true;
      continue;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) throw usageError(`未知参数：${arg}`);

    const eqIndex = arg.indexOf('=');
    const name = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
    let value = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);

    if (valueFlags.has(name)) {
      if (value === undefined) {
        const next = rest[i + 1];
        if (next === undefined || String(next).startsWith('--')) {
          throw usageError(`参数 --${name} 需要一个取值`);
        }
        value = String(next);
        i += 1;
      }
      flags[name] = value;
      continue;
    }
    if (boolFlags.has(name)) {
      if (value !== undefined) throw usageError(`参数 --${name} 是开关，不接受取值`);
      flags[name] = true;
      continue;
    }
    throw usageError(`未知参数：--${name}${command === null ? '' : `（${command} 不支持）`}`);
  }

  if (command !== null && spec && !flags.help && !flags.version) {
    const [min, max] = spec.positionals;
    if (positionals.length < min || positionals.length > max) {
      throw usageError(positionalMessage(command, min, max));
    }
  }

  return { command, positionals, flags };
}

/** 正整数参数（ttl / max-downloads 等）。 */
function parsePositiveInt(raw, name) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw usageError(`${name} 需要是正整数`);
  return value;
}

function parseTimeout(raw, fallbackSeconds) {
  if (raw === undefined) return fallbackSeconds;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 7 * 24 * 3600) {
    throw usageError('--timeout 需要是 1~604800 之间的整数（秒）');
  }
  return value;
}

function parseMode(raw) {
  if (raw === undefined || raw === '') return 'staged';
  if (raw !== 'staged' && raw !== 'p2p') throw usageError('--mode 只能是 staged 或 p2p');
  return raw;
}

// ---------------------------------------------------------------------------
// 配置（命令行 > 环境变量 > 配置文件）
// ---------------------------------------------------------------------------

function configPathOf(flags) {
  if (flags.config !== undefined && String(flags.config).trim() !== '') {
    return path.resolve(String(flags.config).trim());
  }
  const fromEnv = process.env.KUAICHUAN_CONFIG;
  if (fromEnv !== undefined && String(fromEnv).trim() !== '') {
    return path.resolve(String(fromEnv).trim());
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && String(xdg).trim() !== ''
    ? path.resolve(String(xdg).trim())
    : path.join(os.homedir(), '.config');
  return path.join(base, 'kuaichuan', 'config.json');
}

/** 读取配置文件；不存在返回空对象，格式错误直接报错（不猜、不静默丢配置）。 */
async function readConfigFile(flags) {
  const file = configPathOf(flags);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { file, config: {} };
    throw new CliError('config_error', `读取配置文件失败：${err?.message ?? String(err)}`);
  }
  const parsed = parseMaybeJson(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('config_error', `配置文件格式不正确：${file}`);
  }
  return { file, config: parsed };
}

/** 规范化服务地址：只保留 origin，拒绝路径 / 参数 / 锚点与非 http(s)。 */
function normalizeOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') throw new CliError('bad_url', '服务地址不能为空');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('bad_url', `服务地址不合法：${value}（示例：https://share.example.com）`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('bad_url', '服务地址只支持 http 或 https');
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new CliError('bad_url', '服务地址只填 origin（协议 + 域名 + 端口），不要带路径、参数或锚点');
  }
  return url.origin;
}

function pickUrl(flags, config) {
  const raw = flags.url !== undefined
    ? flags.url
    : (process.env.KUAICHUAN_URL !== undefined ? process.env.KUAICHUAN_URL : config?.url);
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  return normalizeOrigin(raw);
}

function resolveApiKey(flags, config) {
  const raw = flags.key !== undefined
    ? flags.key
    : (process.env.KUAICHUAN_API_KEY !== undefined ? process.env.KUAICHUAN_API_KEY : config?.apiKey);
  if (raw === undefined || raw === null) return '';
  return String(raw).trim();
}

async function optionalOrigin(flags) {
  const { config } = await readConfigFile(flags);
  return pickUrl(flags, config);
}

async function requireOrigin(flags) {
  const origin = await optionalOrigin(flags);
  if (!origin) throw notConfiguredError();
  return origin;
}

/** 原子写配置文件，权限 0600；key 只写盘、不回显。 */
async function writeConfigFile(configPath, config) {
  const dir = path.dirname(configPath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, configPath);
    await fsp.chmod(configPath, 0o600).catch(() => {});
  } catch (err) {
    await removeFileQuietly(tmp);
    throw new CliError('config_error', `写入配置文件失败：${err?.message ?? String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP 基础层
// ---------------------------------------------------------------------------

function withApiKey(headers, key) {
  const result = { accept: 'application/json', ...headers };
  if (key) result.authorization = `Bearer ${key}`;
  return result;
}

/** 把 fetch / 流错误收敛成 CliError；网络类错误默认允许重试。 */
function toCliError(err) {
  if (err instanceof CliError) return err;
  const name = err?.name ?? '';
  const cause = err?.cause;
  const detail = cause?.code ?? cause?.message ?? err?.message ?? '网络错误';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new CliError('network_timeout', '请求快传服务超时，请检查网络或服务地址', { retryable: true });
  }
  return new CliError('network_error', `无法连接快传服务：${detail}`, { retryable: true });
}

async function httpFetch(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_API_TIMEOUT_MS, duplex } = {}) {
  const init = { method, headers: headers ?? {} };
  if (timeoutMs && timeoutMs > 0) init.signal = AbortSignal.timeout(Math.ceil(timeoutMs));
  if (body !== undefined) init.body = body;
  if (duplex) init.duplex = duplex;
  try {
    return await fetch(url, init);
  } catch (err) {
    throw toCliError(err);
  }
}

const STATUS_ERROR_CODES = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  500: 'internal_error',
  503: 'unavailable',
  504: 'relay_timeout',
  507: 'insufficient_storage',
};

function errorFromResponse(status, body) {
  const code = body && typeof body.error === 'string' && body.error
    ? body.error
    : (STATUS_ERROR_CODES[status] ?? (status >= 500 ? 'server_error' : 'http_error'));
  const message = body && typeof body.message === 'string' && body.message
    ? body.message
    : `服务返回 HTTP ${status}`;
  return new CliError(code, message, { httpStatus: status });
}

/** JSON 接口：非 2xx 一律转成 CliError，消息尽量沿用服务端中文提示。 */
async function requestJson(url, options = {}) {
  const res = await httpFetch(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw toCliError(err);
  }
  const body = parseMaybeJson(text);
  if (!res.ok) throw errorFromResponse(res.status, body);
  if (body === null && text.trim() !== '') {
    throw new CliError('bad_response', '服务返回了无法解析的响应');
  }
  return { status: res.status, headers: res.headers, data: body ?? {} };
}

/** 二进制 / 文本接口：保留原始响应体，调用方自己消费。 */
async function requestRaw(url, options = {}) {
  const res = await httpFetch(url, options);
  if (res.ok) return res;
  let body = null;
  try {
    const text = await res.text();
    body = parseMaybeJson(text);
  } catch {
    // 错误响应体读不出来也没关系，按状态码兜底
  }
  throw errorFromResponse(res.status, body);
}

/** 中继类错误：对端没来时服务端会 504 / 499，属于「继续等」而不是失败。 */
function isRetryableRelayError(err) {
  if (!(err instanceof CliError)) return false;
  if (err.retryable) return true;
  if (err.code === 'relay_disabled') return false;
  if (err.code === 'relay_failed' || err.code === 'relay_busy') return true;
  if (err.code === 'network_error' || err.code === 'network_timeout') return true;
  if (err.code === 'relay_timeout' || err.code === 'client_gone') return true;
  const status = err.httpStatus;
  if (status === 408 || status === 425 || status === 429 || status === 499) return true;
  if (status !== null && status >= 500 && status <= 504) return true;
  return false;
}

/** 上传重试：偏移冲突（409）与 5xx 都可以靠断点续传恢复；413/507 等直接失败。 */
function isRetryableUploadError(err) {
  if (!(err instanceof CliError)) return false;
  if (err.code === 'network_error' || err.code === 'network_timeout') return true;
  if (err.code === 'upload_incomplete') return true;
  const status = err.httpStatus;
  if (status === 409 || status === 425 || status === 429 || status === 499) return true;
  if (status === 507 || status === 413) return false;
  if (status !== null && status >= 500 && status <= 504) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 状态目录与状态文件
// ---------------------------------------------------------------------------

function stateDirOf(flags) {
  const raw = flags['state-dir'] !== undefined ? flags['state-dir'] : process.env.KUAICHUAN_STATE_DIR;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return path.resolve(String(raw).trim());
  }
  return path.resolve(process.cwd(), '.kuaichuan');
}

function emptyState() {
  return { version: STATE_VERSION, shares: {} };
}

async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700).catch(() => {});
}

/** 读状态；文件不存在返回空状态，损坏则报错而不是覆盖。 */
async function loadState(stateDir) {
  const file = path.join(stateDir, 'state.json');
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return emptyState();
    throw new CliError('bad_state', `读取本地状态失败：${err?.message ?? String(err)}`);
  }
  const parsed = parseMaybeJson(raw);
  if (
    parsed === null
    || typeof parsed !== 'object'
    || parsed.version !== STATE_VERSION
    || parsed.shares === null
    || typeof parsed.shares !== 'object'
  ) {
    throw new CliError('bad_state', `本地状态文件格式不正确：${file}`);
  }
  return parsed;
}

/** 原子写状态：临时文件 + rename，权限 0600。 */
async function saveState(stateDir, state) {
  await ensurePrivateDir(stateDir);
  const target = path.join(stateDir, 'state.json');
  const tmp = path.join(stateDir, `.state.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, target);
    await fsp.chmod(target, 0o600).catch(() => {});
  } catch (err) {
    await removeFileQuietly(tmp);
    throw new CliError('bad_state', `写入本地状态失败：${err?.message ?? String(err)}`);
  }
}

async function upsertShareEntry(stateDir, entry) {
  const state = await loadState(stateDir);
  state.shares[entry.id] = entry;
  await saveState(stateDir, state);
}

async function updateTransfer(stateDir, id, patch) {
  const state = await loadState(stateDir);
  const entry = state.shares[id];
  if (!entry) return;
  const previous = entry.transfer ?? { status: 'waiting', bytes: 0, total: 0, error: null, updatedAt: 0 };
  entry.transfer = { ...previous, ...patch, updatedAt: Date.now() };
  await saveState(stateDir, state);
}

function buildShareEntry(created, { status = 'waiting', bytes = 0, password = null, ownerToken = null } = {}) {
  return {
    id: created.id,
    url: created.url,
    kind: created.kind,
    mode: created.mode,
    title: created.title,
    ownerToken: ownerToken ?? created.ownerToken ?? null,
    password: password ?? created.password ?? null,
    createdAt: Date.now(),
    expiresAt: created.expiresAt,
    transfer: {
      status,
      bytes,
      total: created.totalBytes ?? 0,
      error: null,
      updatedAt: Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// P2P 后台发送数据（payload）
// ---------------------------------------------------------------------------

async function payloadPathOf(stateDir, id) {
  return path.join(stateDir, 'payloads', `${id}.json`);
}

async function writePayload(stateDir, id, payload) {
  const dir = path.join(stateDir, 'payloads');
  await ensurePrivateDir(dir);
  const file = await payloadPathOf(stateDir, id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600).catch(() => {});
    await fsp.rename(tmp, file);
  } catch (err) {
    await removeFileQuietly(tmp);
    throw new CliError('bad_state', `写入后台发送数据失败：${err?.message ?? String(err)}`);
  }
  return file;
}

async function readPayload(stateDir, id) {
  const file = await payloadPathOf(stateDir, id);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = parseMaybeJson(raw);
    if (parsed === null || typeof parsed !== 'object') throw new Error('bad json');
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') throw new CliError('bad_state', `找不到后台发送数据：${file}`);
    throw new CliError('bad_state', `后台发送数据损坏：${file}`);
  }
}

async function removePayload(stateDir, id) {
  await removeFileQuietly(await payloadPathOf(stateDir, id));
}

// ---------------------------------------------------------------------------
// 分享引用解析 / 路径安全
// ---------------------------------------------------------------------------

function isFullShareUrl(ref) {
  return /^https?:\/\//i.test(String(ref ?? '').trim());
}

/**
 * 解析分享链接或 ID：
 *   https://host/s/ID、http://host/s/ID?t=…、/s/ID、纯 ID 都支持；
 *   没有服务地址的引用需要 fallbackOrigin（来自配置或环境变量）。
 * @returns {{ origin: string, id: string }}
 */
function parseShareRef(ref, fallbackOrigin = null) {
  const value = String(ref ?? '').trim();
  if (value === '') throw usageError('需要分享链接或分享 ID');

  if (isFullShareUrl(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new CliError('bad_ref', `分享链接不合法：${value}`);
    }
    const match = /^\/s\/([A-Za-z0-9]{4,32})\/?$/.exec(url.pathname);
    if (!match) {
      throw new CliError('bad_ref', '无法从链接中识别分享 ID（应形如 https://host/s/Ab12cd）');
    }
    return { origin: url.origin, id: match[1] };
  }

  const relative = /^\/?s\/([A-Za-z0-9]{4,32})\/?$/.exec(value);
  if (relative) {
    if (!fallbackOrigin) {
      throw notConfiguredError('这个链接没有带服务地址，请用完整链接，或先 setup 配置服务地址');
    }
    return { origin: fallbackOrigin, id: relative[1] };
  }

  if (SHARE_ID_RE.test(value)) {
    if (!fallbackOrigin) {
      throw notConfiguredError('只给分享 ID 时需要先配置服务地址，请用完整链接或先 setup');
    }
    return { origin: fallbackOrigin, id: value };
  }

  throw new CliError('bad_ref', `无法识别分享链接或 ID：${value}`);
}

/** 从状态里存的分享链接取 origin。 */
function shareOrigin(shareUrl) {
  try {
    return new URL(String(shareUrl)).origin;
  } catch {
    throw new CliError('bad_state', `本地状态里的分享地址不合法：${shareUrl}`);
  }
}

/**
 * 把服务端给的 relPath 净化成可安全落盘的相对路径：
 * 去掉前导 /、. 与 .. 段、Windows 非法字符与结尾的点/空格。
 */
function sanitizeRelPath(raw, fallback = 'file') {
  const source = String(raw ?? '').replace(/\\/g, '/');
  const parts = [];
  for (const segment of source.split('/')) {
    if (!segment || segment === '.' || segment === '..') continue;
    let safe = segment.replace(/[<>:"|?*\u0000-\u001f]/g, '_');
    safe = safe.replace(/[. ]+$/, '');
    if (!safe) continue;
    parts.push(safe);
  }
  return parts.length > 0 ? parts.join(path.sep) : fallback;
}

/** 同一目录下多个文件净化后撞名时，用 idx 后缀保证不互相覆盖。 */
function uniquePath(desired, used, idx) {
  if (!used.has(desired)) {
    used.add(desired);
    return desired;
  }
  const ext = path.extname(desired);
  const base = ext ? desired.slice(0, -ext.length) : desired;
  let candidate = `${base}-${idx}${ext}`;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${idx}-${suffix}${ext}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// 创建分享体 / 发送
// ---------------------------------------------------------------------------

/**
 * 组装 POST /api/agent/v1/shares 的请求体。
 * password 默认 true（AI 场景默认带密码），与服务端 toCreateInput 语义一致。
 */
function buildCreateBody({
  kind,
  mode = 'staged',
  title,
  password = true,
  ttlHours,
  maxDownloads,
  burnAfterRead = false,
  text,
  files,
}) {
  const body = { kind, mode, password: password === true };
  if (title !== undefined && title !== '') body.title = String(title);
  if (ttlHours !== undefined) body.ttlHours = ttlHours;
  if (maxDownloads !== undefined) body.maxDownloads = maxDownloads;
  if (burnAfterRead === true) body.burnAfterRead = true;
  if (kind === 'text') body.text = String(text ?? '');
  if (kind === 'file') {
    body.files = (files ?? []).map((file) => ({
      name: file.name,
      relPath: file.relPath,
      size: file.size,
    }));
  }
  return body;
}

async function createShare({ origin, apiKey, body }) {
  const { data } = await requestJson(`${origin}/api/agent/v1/shares`, {
    method: 'POST',
    headers: withApiKey({ 'content-type': 'application/json' }, apiKey),
    body: JSON.stringify(body),
  });
  if (!data || typeof data.id !== 'string' || typeof data.url !== 'string') {
    throw new CliError('bad_response', '创建分享的响应不完整');
  }
  if (data.requiresPassword && !data.password) {
    throw new CliError('bad_response', '服务端没有返回分享密码');
  }
  return data;
}

/** p2p 必须依赖服务端内存中继，未启用就尽早失败（并清理刚创建的分享）。 */
async function assertRelayReady(created, origin) {
  if (created.mode !== 'p2p') return;
  if (!created.relay || typeof created.relay !== 'object') {
    throw new CliError('bad_response', '服务端没有返回 P2P 中继信息');
  }
  if (created.relay.enabled === false) {
    if (created.ownerToken) {
      await requestJson(`${origin}/api/shares/${created.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${created.ownerToken}` },
      }).catch(() => {});
    }
    throw new CliError('relay_disabled', '服务端未启用内存中继，无法用 p2p 发送，请改用默认的 staged 模式');
  }
}

/**
 * 发送前按能力发现里的上限预检文件数。
 *
 * 超限时直接报错，不创建分享，避免留下一个注定传不完的空分享；
 * 发现接口不可用时跳过预检，让创建接口返回同一条限制。
 */
async function assertFileCountWithinLimit({ origin, apiKey, count }) {
  let limit;
  try {
    const { data } = await requestJson(`${origin}/api/agent/v1`, {
      headers: withApiKey({}, apiKey),
    });
    limit = Number(data?.limits?.maxFilesPerShare);
  } catch {
    return;
  }
  if (!Number.isInteger(limit) || limit <= 0 || count <= limit) return;
  throw new CliError(
    'too_many_files',
    `单个分享最多 ${limit} 个文件，本次有 ${count} 个；请按目录拆分成多个分享后分批发送`,
  );
}

/** 展开 send-file 的路径参数；目录递归、保留相对路径、跳过空目录。 */
async function expandPaths(inputs) {
  const entries = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      throw new CliError('file_not_found', `路径不存在：${input}`);
    }
    if (stat.isFile()) {
      entries.push({
        absPath: abs,
        name: path.basename(abs),
        relPath: path.basename(abs),
        size: stat.size,
      });
      continue;
    }
    if (stat.isDirectory()) {
      const dirName = path.basename(abs) || 'files';
      const relatives = await walkDirectory(abs);
      for (const rel of relatives) {
        const fileAbs = path.join(abs, rel);
        let fileStat;
        try {
          fileStat = await fsp.stat(fileAbs);
        } catch {
          continue;
        }
        if (!fileStat.isFile()) continue;
        entries.push({
          absPath: fileAbs,
          name: path.basename(rel),
          relPath: `${dirName}/${rel.split(path.sep).join('/')}`,
          size: fileStat.size,
        });
      }
      continue;
    }
    throw new CliError('bad_path', `不支持的路径类型：${input}`);
  }
  return entries;
}

/** 目录遍历：排序保证可复现；不跟随目录符号链接，避免环与越界。 */
async function walkDirectory(root) {
  const output = [];
  async function walk(current, prefix) {
    let items;
    try {
      items = await fsp.readdir(current, { withFileTypes: true });
    } catch (err) {
      throw new CliError('file_not_found', `读取目录失败：${current}（${err?.code ?? err?.message}）`);
    }
    items.sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      const abs = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (item.isFile()) {
        output.push(rel.split('/').join(path.sep));
        continue;
      }
      if (item.isSymbolicLink()) {
        // 指向普通文件的链接跟随；指向目录的跳过（防环、防越界）
        const target = await fsp.stat(abs).catch(() => null);
        if (target?.isFile()) output.push(rel.split('/').join(path.sep));
      }
    }
  }
  await walk(root, '');
  return output;
}

/** 读取 send-text 的文字来源：位置参数 > --text > --stdin > --file。 */
async function readTextSource(flags, positionals) {
  if (positionals.length > 0) return positionals.join(' ');
  if (flags.text !== undefined) return String(flags.text);
  if (flags.stdin) return await readStdin();
  if (flags.file !== undefined) {
    const file = path.resolve(String(flags.file));
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      throw new CliError('file_not_found', `读取文字文件失败：${flags.file}（${err?.code ?? err?.message}）`);
    }
  }
  throw usageError('请提供要分享的文字：位置参数、--text、--stdin 或 --file');
}

// ---------------------------------------------------------------------------
// 暂存上传（流式 + 断点续传）
// ---------------------------------------------------------------------------

/** 查询服务器已收到多少字节。 */
async function queryUploadStatus(resume, deadline) {
  for (;;) {
    assertBeforeDeadline(deadline, '上传超时：服务器一直没能返回断点信息');
    try {
      const { data } = await requestJson(resume.url, {
        method: resume.method ?? 'GET',
        headers: resume.headers ?? {},
        timeoutMs: Math.min(DEFAULT_API_TIMEOUT_MS, remainingMs(deadline)),
      });
      if (!data || typeof data.received !== 'number') {
        throw new CliError('bad_response', '上传进度接口返回了无法识别的数据');
      }
      return data;
    } catch (err) {
      const error = toCliError(err);
      if (!isRetryableUploadError(error)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** 从 offset 开始流式 PUT 剩余内容；422/202 都按「未完成」交给外层续传。 */
async function putFileChunk({ upload, localPath, offset, size, deadline }) {
  const length = size - offset;
  const headers = { ...(upload.headers ?? {}), 'upload-offset': String(offset) };
  let body;
  let stream = null;
  if (length === 0) {
    headers['content-length'] = '0';
    body = Buffer.alloc(0);
  } else {
    headers['content-length'] = String(length);
    stream = fs.createReadStream(localPath, { start: offset, end: size - 1 });
    body = stream;
  }
  try {
    const res = await httpFetch(upload.url, {
      method: upload.method ?? 'PUT',
      headers,
      body,
      duplex: stream ? 'half' : undefined,
      timeoutMs: attemptTimeout(deadline),
    });
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw toCliError(err);
    }
    const parsed = parseMaybeJson(text);
    if (!res.ok) throw errorFromResponse(res.status, parsed);
    if (parsed === null || typeof parsed !== 'object') {
      throw new CliError('bad_response', '上传接口返回了无法解析的响应');
    }
    return {
      complete: parsed.complete === true,
      received: typeof parsed.received === 'number' ? parsed.received : offset + length,
    };
  } catch (err) {
    throw toCliError(err);
  } finally {
    stream?.destroy();
  }
}

/**
 * 上传单个暂存文件：每次尝试前都问服务器已收到多少字节，再用 Upload-Offset 续传，
 * 失败按 --timeout 的窗口反复重试（默认 600 秒）。
 */
async function uploadStagedFile({ file, localPath, timeoutSeconds, onProgress }) {
  const size = Number(file.size) || 0;
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    assertBeforeDeadline(deadline, `上传“${file.name}”超时（${timeoutSeconds} 秒）`);

    // 上传期间本地文件被改写就不能再续传，否则服务器上的长度会对不上
    let stat;
    try {
      stat = await fsp.stat(localPath);
    } catch {
      throw new CliError('file_not_found', `本地文件已不存在：${localPath}`);
    }
    if (stat.size !== size) {
      throw new CliError('file_changed', `本地文件大小已变化，无法继续上传：${localPath}`);
    }

    const status = await queryUploadStatus(file.upload.resume, deadline);
    if (status.complete) {
      onProgress?.(size);
      return { bytes: size, complete: true };
    }
    const offset = Math.max(0, Math.min(Number(status.received) || 0, size));

    try {
      const result = await putFileChunk({
        upload: file.upload,
        localPath,
        offset,
        size,
        deadline,
      });
      onProgress?.(result.received);
      if (result.complete) return { bytes: size, complete: true };
      // 202 表示服务器只收到部分内容，下一轮从新断点继续
    } catch (err) {
      const error = toCliError(err);
      if (!isRetryableUploadError(error)) throw error;
    }
    await sleep(RETRY_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// P2P 中继发送（前台 / 后台子进程共用）
// ---------------------------------------------------------------------------

/**
 * 发送文字到中继端点；服务端会挂起等待接收方，504/499/网络错误都继续重试。
 */
async function relaySendText({ url, headers, text, deadline, log, setStatus }) {
  const body = Buffer.from(text, 'utf8');
  for (;;) {
    assertBeforeDeadline(deadline, '等待接收方超时：P2P 分享需要接收方在发送方在线期间取件');
    await setStatus?.('sending');
    try {
      const res = await httpFetch(url, {
        method: 'POST',
        headers: { ...headers, accept: 'application/json' },
        body,
        timeoutMs: attemptTimeout(deadline),
      });
      let parsed = null;
      try {
        const raw = await res.text();
        parsed = parseMaybeJson(raw);
      } catch (err) {
        throw toCliError(err);
      }
      if (!res.ok) throw errorFromResponse(res.status, parsed);
      if (parsed && parsed.ok === false) {
        const retryable = parsed.error !== 'payload_too_large';
        throw new CliError(parsed.error ?? 'relay_failed', parsed.message ?? '中继传输失败', { retryable });
      }
      return { bytes: body.length };
    } catch (err) {
      const error = toCliError(err);
      if (!isRetryableRelayError(error)) throw error;
      log?.(`等待接收方（${error.code}：${error.message}），1 秒后重试`);
      await setStatus?.('waiting');
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** 发送文件到中继端点；接收方断开时服务端返回 ok:false，按失败重新等待。 */
async function relaySendFile({ url, headers, localPath, size, deadline, log, setStatus }) {
  for (;;) {
    assertBeforeDeadline(deadline, '等待接收方超时：P2P 分享需要接收方在发送方在线期间取件');

    let stat;
    try {
      stat = await fsp.stat(localPath);
    } catch {
      throw new CliError('file_not_found', `本地文件已不存在：${localPath}`);
    }
    if (!stat.isFile()) throw new CliError('file_not_found', `本地路径不是文件：${localPath}`);
    if (stat.size !== size) throw new CliError('file_changed', `本地文件大小已变化，无法发送：${localPath}`);

    await setStatus?.('sending');
    let stream = null;
    try {
      const requestHeaders = { ...headers };
      let body;
      if (size === 0) {
        requestHeaders['content-length'] = '0';
        body = Buffer.alloc(0);
      } else {
        requestHeaders['content-length'] = String(size);
        stream = fs.createReadStream(localPath);
        body = stream;
      }
      const res = await httpFetch(url, {
        method: 'POST',
        headers: requestHeaders,
        body,
        duplex: stream ? 'half' : undefined,
        timeoutMs: attemptTimeout(deadline),
      });
      let parsed = null;
      try {
        const raw = await res.text();
        parsed = parseMaybeJson(raw);
      } catch (err) {
        throw toCliError(err);
      }
      if (!res.ok) throw errorFromResponse(res.status, parsed);
      if (parsed && parsed.ok === false) {
        const retryable = parsed.error !== 'payload_too_large';
        throw new CliError(parsed.error ?? 'relay_failed', parsed.message ?? '中继传输失败', { retryable });
      }
      return { bytes: size };
    } catch (err) {
      const error = toCliError(err);
      if (!isRetryableRelayError(error)) throw error;
      log?.(`等待接收方（${error.code}：${error.message}），1 秒后重试`);
      await setStatus?.('waiting');
      await sleep(RETRY_DELAY_MS);
    } finally {
      stream?.destroy();
    }
  }
}

/**
 * 执行一次 P2P 发送（父进程前台模式与后台子进程共用）。
 * 每成功一个文件就更新本地状态里的 transfer.bytes，全部完成标记 done。
 */
async function runRelaySend({ stateDir, id, timeoutSeconds, log }) {
  const state = await loadState(stateDir);
  const entry = state.shares[id];
  if (!entry || !entry.ownerToken) {
    throw new CliError('bad_state', `本地状态里找不到分享 ${id} 的发送凭据`);
  }
  const payload = await readPayload(stateDir, id);
  const origin = shareOrigin(entry.url);
  const relay = payload.relay && typeof payload.relay === 'object' ? payload.relay : {};
  const total = Number(entry.transfer?.total ?? payload.totalBytes ?? 0);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const authHeaders = entry.ownerToken ? { authorization: `Bearer ${entry.ownerToken}` } : {};

  const setStatus = async (status, patch = {}) => {
    await updateTransfer(stateDir, id, { status, total, ...patch });
  };
  const logLine = (message) => {
    if (typeof log === 'function') log(message);
  };

  let bytes = 0;
  await setStatus('waiting', { error: null });

  if (payload.kind === 'text') {
    const text = String(payload.text ?? '');
    const url = relay.sendText?.url ?? `${origin}/api/relay/${id}/text`;
    await relaySendText({
      url,
      headers: { ...authHeaders, 'content-type': 'text/plain; charset=utf-8' },
      text,
      deadline,
      log: logLine,
      setStatus,
    });
    bytes = Buffer.byteLength(text, 'utf8');
    await setStatus('done', { bytes, error: null });
  } else {
    const files = Array.isArray(payload.files)
      ? [...payload.files].sort((a, b) => a.idx - b.idx)
      : [];
    if (files.length === 0) throw new CliError('bad_state', '后台发送数据里没有待发送文件');
    for (const file of files) {
      const url = (relay.sendFile?.url ?? `${origin}/api/relay/${id}/f/{idx}`)
        .replace('{idx}', String(file.idx));
      await relaySendFile({
        url,
        headers: { ...authHeaders, 'content-type': 'application/octet-stream' },
        localPath: file.path,
        size: Number(file.size) || 0,
        deadline,
        log: logLine,
        setStatus,
      });
      bytes += Number(file.size) || 0;
      await setStatus('sending', { bytes });
    }
    await setStatus('done', { bytes, error: null });
  }

  // 文本内容/文件路径只用于后台发送，完成即清理，避免敏感内容长期留在状态目录
  await removePayload(stateDir, id);
  logLine(`P2P 发送完成，共 ${bytes} 字节`);
  return { bytes };
}

/** 创建 detached 后台子进程；返回 pid 与日志路径。 */
async function startBackgroundRelay({ stateDir, id, timeoutSeconds }) {
  const logsDir = path.join(stateDir, 'logs');
  await ensurePrivateDir(logsDir);
  const logPath = path.join(logsDir, `${id}.log`);
  const scriptPath = fileURLToPath(import.meta.url);
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [scriptPath, '__relay-send', '--id', id, '--state-dir', stateDir, '--timeout', String(timeoutSeconds)],
      {
        detached: true,
        stdio: ['ignore', fd, fd],
        cwd: process.cwd(),
        env: process.env,
      },
    );
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return { pid: child.pid, log: logPath };
  } catch (err) {
    throw new CliError('spawn_failed', `启动后台发送进程失败：${err?.message ?? String(err)}`);
  } finally {
    fs.closeSync(fd);
  }
}

/** 写入等待状态 + payload，然后按前台/后台发送；返回给调用方输出的 JSON。 */
async function dispatchRelaySend({ created, payload, stateDir, timeoutSeconds, foreground }) {
  const entry = buildShareEntry(created, { status: 'waiting' });
  await upsertShareEntry(stateDir, entry);
  await writePayload(stateDir, created.id, {
    kind: created.kind,
    totalBytes: created.totalBytes,
    relay: created.relay,
    ...payload,
  });

  if (foreground) {
    await runRelaySend({ stateDir, id: created.id, timeoutSeconds, log: null });
    const state = await loadState(stateDir);
    return { ...created, background: false, sent: true, transfer: state.shares[created.id]?.transfer ?? null };
  }

  const background = await startBackgroundRelay({ stateDir, id: created.id, timeoutSeconds });
  return { ...created, background: true, pid: background.pid, log: background.log };
}

// ---------------------------------------------------------------------------
// 下载 / 接收
// ---------------------------------------------------------------------------

/** 把响应体流式写入 .part 文件，返回字节数；中断时清理半成品。 */
async function saveResponseToFile(res, partPath) {
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const writeStream = fs.createWriteStream(partPath, { mode: 0o600 });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, writeStream);
  } catch (err) {
    writeStream.destroy();
    await removeFileQuietly(partPath);
    throw new CliError('network_error', `接收内容中断：${err?.message ?? '连接中断'}`, { retryable: true });
  }
  return bytes;
}

async function finalizePart(partPath, targetPath) {
  // --overwrite 时才允许覆盖；先删再 rename 兼容 Windows
  await removeFileQuietly(targetPath);
  await fsp.rename(partPath, targetPath);
}

/** 暂存文件下载：保存到 .part 再 rename，校验字节数与创建时声明一致。 */
async function downloadStagedFile({ origin, id, token, file, partPath, targetPath }) {
  await removeFileQuietly(partPath);
  const url = `${origin}/api/shares/${id}/files/${file.idx}?t=${encodeURIComponent(token)}`;
  let bytes;
  try {
    const res = await requestRaw(url, { timeoutMs: 0 });
    bytes = await saveResponseToFile(res, partPath);
  } catch (err) {
    await removeFileQuietly(partPath);
    throw toCliError(err);
  }
  if (typeof file.size === 'number' && file.size >= 0 && bytes !== file.size) {
    await removeFileQuietly(partPath);
    throw new CliError('download_incomplete', `文件“${file.name}”下载不完整（${bytes}/${file.size} 字节），请重试`);
  }
  await finalizePart(partPath, targetPath);
  return bytes;
}

/** P2P 文件接收：中继没有 Range，失败就删掉 .part 从头再来，直到 --timeout。 */
async function downloadRelayFile({ origin, id, token, file, partPath, targetPath, deadline }) {
  for (;;) {
    assertBeforeDeadline(deadline, `接收“${file.name}”超时：P2P 分享需要发送方保持在线`);
    await removeFileQuietly(partPath);
    try {
      const url = `${origin}/api/relay/${id}/f/${file.idx}?t=${encodeURIComponent(token)}`;
      const res = await requestRaw(url, { timeoutMs: attemptTimeout(deadline) });
      const bytes = await saveResponseToFile(res, partPath);
      const expected = Number(file.size);
      if (Number.isInteger(expected) && expected >= 0 && bytes !== expected) {
        throw new CliError('download_incomplete', `文件“${file.name}”接收不完整（${bytes}/${expected} 字节）`, {
          retryable: true,
        });
      }
      await finalizePart(partPath, targetPath);
      return bytes;
    } catch (err) {
      await removeFileQuietly(partPath);
      const error = toCliError(err);
      if (!isRetryableRelayError(error)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// 命令：setup / info
// ---------------------------------------------------------------------------

async function commandSetup(flags) {
  if (flags.url === undefined || String(flags.url).trim() === '') {
    throw usageError('setup 需要 --url <服务地址>，例如：setup --url https://share.example.com');
  }
  const { config } = await readConfigFile(flags);
  const origin = normalizeOrigin(flags.url);
  const apiKey = resolveApiKey(flags, config);

  // 先校验服务端确实开启了 AI 接入（Key 不对或未启用都会在这里失败），成功才落盘
  const { data } = await requestJson(`${origin}/api/agent/v1`, { headers: withApiKey({}, apiKey) });
  if (!data || data.enabled !== true) {
    throw new CliError('agent_disabled', '该服务没有启用 AI 接入（AGENT_ENABLED=0）');
  }

  const configPath = configPathOf(flags);
  await writeConfigFile(configPath, { url: origin, apiKey });
  printJson({
    ok: true,
    url: origin,
    configPath,
    auth: typeof data.auth === 'string' ? data.auth : (apiKey ? 'api-key' : 'none'),
  });
}

async function commandInfo(flags) {
  const { config } = await readConfigFile(flags);
  const origin = pickUrl(flags, config);
  if (!origin) throw notConfiguredError();
  const apiKey = resolveApiKey(flags, config);
  const { data } = await requestJson(`${origin}/api/agent/v1`, { headers: withApiKey({}, apiKey) });
  printJson(data);
}

// ---------------------------------------------------------------------------
// 命令：send-text / send-file
// ---------------------------------------------------------------------------

async function commandSendText(flags, positionals) {
  const { config } = await readConfigFile(flags);
  const origin = pickUrl(flags, config);
  if (!origin) throw notConfiguredError();
  const apiKey = resolveApiKey(flags, config);
  const stateDir = stateDirOf(flags);
  const mode = parseMode(flags.mode);
  const defaultTimeout = mode === 'p2p' ? DEFAULT_P2P_TIMEOUT_SECONDS : DEFAULT_STAGED_TIMEOUT_SECONDS;
  const timeoutSeconds = parseTimeout(flags.timeout, defaultTimeout);

  const text = await readTextSource(flags, positionals);
  if (text.trim() === '') throw new CliError('bad_request', '文字内容不能为空');

  const body = buildCreateBody({
    kind: 'text',
    mode,
    title: flags.title,
    password: flags['no-password'] !== true,
    ttlHours: parsePositiveInt(flags.ttl, '--ttl'),
    maxDownloads: parsePositiveInt(flags['max-downloads'], '--max-downloads'),
    burnAfterRead: flags.burn === true,
    text,
  });

  const created = await createShare({ origin, apiKey, body });
  await assertRelayReady(created, origin);

  const entry = buildShareEntry(created, { status: mode === 'p2p' ? 'waiting' : 'done' });
  if (mode !== 'p2p') entry.transfer.bytes = created.totalBytes;
  await upsertShareEntry(stateDir, entry);

  if (mode === 'p2p') {
    const output = await dispatchRelaySend({
      created,
      payload: { kind: 'text', text },
      stateDir,
      timeoutSeconds,
      foreground: flags.foreground === true,
    });
    printJson(output);
    return;
  }
  printJson(created);
}

async function commandSendFile(flags, positionals) {
  const { config } = await readConfigFile(flags);
  const origin = pickUrl(flags, config);
  if (!origin) throw notConfiguredError();
  const apiKey = resolveApiKey(flags, config);
  const stateDir = stateDirOf(flags);
  const mode = parseMode(flags.mode);
  const defaultTimeout = mode === 'p2p' ? DEFAULT_P2P_TIMEOUT_SECONDS : DEFAULT_STAGED_TIMEOUT_SECONDS;
  const timeoutSeconds = parseTimeout(flags.timeout, defaultTimeout);

  const localFiles = await expandPaths(positionals);
  if (localFiles.length === 0) throw new CliError('no_files', '没有找到可分享的文件（空目录会被忽略）');
  await assertFileCountWithinLimit({ origin, apiKey, count: localFiles.length });

  const body = buildCreateBody({
    kind: 'file',
    mode,
    title: flags.title,
    password: flags['no-password'] !== true,
    ttlHours: parsePositiveInt(flags.ttl, '--ttl'),
    maxDownloads: parsePositiveInt(flags['max-downloads'], '--max-downloads'),
    burnAfterRead: flags.burn === true,
    files: localFiles,
  });

  const created = await createShare({ origin, apiKey, body });
  await assertRelayReady(created, origin);

  if (!Array.isArray(created.files) || created.files.length !== localFiles.length) {
    throw new CliError('bad_response', '服务端返回的文件列表与本地不一致');
  }

  if (mode === 'p2p') {
    const entry = buildShareEntry(created, { status: 'waiting' });
    await upsertShareEntry(stateDir, entry);
    const payload = {
      kind: 'file',
      files: created.files.map((remote) => {
        const local = localFiles[remote.idx];
        if (!local) throw new CliError('bad_response', '服务端返回的文件序号与本地不一致');
        return { idx: remote.idx, path: local.absPath, size: remote.size };
      }),
    };
    const output = await dispatchRelaySend({
      created,
      payload,
      stateDir,
      timeoutSeconds,
      foreground: flags.foreground === true,
    });
    printJson(output);
    return;
  }

  // 暂存：先落一条 sending 状态，再逐个流式上传，失败按断点续传重试
  const entry = buildShareEntry(created, { status: 'sending' });
  await upsertShareEntry(stateDir, entry);

  try {
    let bytes = 0;
    for (const remote of created.files) {
      const local = localFiles[remote.idx];
      if (!local) throw new CliError('bad_response', '服务端返回的文件序号与本地不一致');
      await uploadStagedFile({
        file: remote,
        localPath: local.absPath,
        timeoutSeconds,
        onProgress: () => {},
      });
      bytes += Number(remote.size) || 0;
      await updateTransfer(stateDir, created.id, { status: 'sending', bytes });
    }
    await updateTransfer(stateDir, created.id, { status: 'done', bytes, error: null });
  } catch (err) {
    const error = toCliError(err);
    await updateTransfer(stateDir, created.id, {
      status: 'failed',
      error: error.message,
    }).catch(() => {});
    throw error;
  }

  printJson(created);
}

// ---------------------------------------------------------------------------
// 命令：recv
// ---------------------------------------------------------------------------

async function receiveText({ origin, id, token, mode, deadline }) {
  if (mode === 'staged') {
    const res = await requestRaw(`${origin}/api/shares/${id}/text?t=${encodeURIComponent(token)}`, { timeoutMs: 0 });
    try {
      return await res.text();
    } catch (err) {
      throw new CliError('network_error', `读取文字失败：${err?.message ?? '连接中断'}`);
    }
  }

  for (;;) {
    assertBeforeDeadline(deadline, '等待发送方超时：P2P 分享需要发送方保持在线');
    try {
      const res = await requestRaw(`${origin}/api/relay/${id}/text?t=${encodeURIComponent(token)}`, {
        timeoutMs: attemptTimeout(deadline),
      });
      return await res.text();
    } catch (err) {
      const error = toCliError(err);
      if (!isRetryableRelayError(error)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function receiveFiles({ origin, id, token, meta, outDir, mode, deadline, overwrite }) {
  const files = Array.isArray(meta.files) ? [...meta.files].sort((a, b) => a.idx - b.idx) : [];
  if (files.length === 0) throw new CliError('not_found', '该分享没有可下载的文件');

  await fsp.mkdir(outDir, { recursive: true });

  const used = new Set();
  const planned = files.map((file) => {
    const relative = sanitizeRelPath(file.relPath ?? file.name, `file-${file.idx}`);
    const desired = path.resolve(outDir, relative);
    if (desired !== outDir && !desired.startsWith(outDir + path.sep)) {
      throw new CliError('unsafe_path', `文件名不安全，已拒绝：${file.relPath ?? file.name}`);
    }
    const target = uniquePath(desired, used, file.idx);
    return { file, target, part: `${target}.part` };
  });

  // 目录分享的 relPath 可能带子目录，先建好父目录再下载
  for (const item of planned) {
    await fsp.mkdir(path.dirname(item.target), { recursive: true });
  }

  if (!overwrite) {
    for (const item of planned) {
      const exists = await fsp.lstat(item.target).then(() => true).catch(() => false);
      if (exists) {
        throw new CliError('file_exists', `目标文件已存在：${item.target}，如需覆盖请加 --overwrite`);
      }
    }
  }

  const results = [];
  for (const item of planned) {
    const file = item.file;
    const bytes = mode === 'p2p'
      ? await downloadRelayFile({
        origin,
        id,
        token,
        file,
        partPath: item.part,
        targetPath: item.target,
        deadline,
      })
      : await downloadStagedFile({
        origin,
        id,
        token,
        file,
        partPath: item.part,
        targetPath: item.target,
      });
    results.push({
      idx: file.idx,
      name: file.name,
      path: item.target,
      bytes,
    });
  }

  printJson({ id, title: meta.title, mode, dir: outDir, files: results });
}

async function commandRecv(flags, positionals) {
  const ref = positionals[0];
  const fallbackOrigin = isFullShareUrl(ref) ? null : await optionalOrigin(flags);
  const { origin, id } = parseShareRef(ref, fallbackOrigin);
  const timeoutSeconds = parseTimeout(flags.timeout, DEFAULT_RECV_TIMEOUT_SECONDS);
  const deadline = Date.now() + timeoutSeconds * 1000;

  // 未显式提供密码时不带密码；提供了空串则视为「已提供空密码」，交给服务端判定
  const password = flags.password !== undefined
    ? String(flags.password)
    : (process.env.KUAICHUAN_PASSWORD !== undefined ? process.env.KUAICHUAN_PASSWORD : null);

  const publicInfo = (await requestJson(`${origin}/api/shares/${id}/public`)).data;
  if (publicInfo?.requiresPassword && (password === null || password === '')) {
    throw new CliError('password_required', '该分享需要密码，请用 --password <密码> 或设置环境变量 KUAICHUAN_PASSWORD');
  }

  const unlock = (await requestJson(`${origin}/api/shares/${id}/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: password ?? '' }),
  })).data;
  const token = unlock?.accessToken;
  if (typeof token !== 'string' || token === '') {
    throw new CliError('bad_response', '解锁响应里缺少访问令牌');
  }

  const meta = (await requestJson(`${origin}/api/shares/${id}?t=${encodeURIComponent(token)}`)).data;
  const shareUrl = `${origin}/s/${id}`;

  if (flags.info) {
    printJson({ ...meta, url: shareUrl });
    return;
  }

  if (meta.kind === 'text') {
    const text = await receiveText({ origin, id, token, mode: meta.mode, deadline });
    if (flags.json) {
      const downloads = Number(meta.downloads ?? 0) + 1;
      printJson({
        id,
        title: meta.title,
        mode: meta.mode,
        text,
        totalBytes: meta.textBytes ?? null,
        downloads,
        maxDownloads: meta.maxDownloads ?? null,
        downloadsLeft: meta.maxDownloads === null || meta.maxDownloads === undefined
          ? null
          : Math.max(0, meta.maxDownloads - downloads),
        burned: meta.burnAfterRead === true,
        expiresAt: meta.expiresAt ?? null,
        url: shareUrl,
      });
    } else {
      // 正文原样输出，不加任何提示或换行
      process.stdout.write(text);
    }
    return;
  }

  const outDir = flags.out !== undefined && String(flags.out).trim() !== ''
    ? path.resolve(String(flags.out).trim())
    : path.resolve(process.cwd(), `kuaichuan-${id}`);
  await receiveFiles({
    origin,
    id,
    token,
    meta,
    outDir,
    mode: meta.mode,
    deadline,
    overwrite: flags.overwrite === true,
  });
}

// ---------------------------------------------------------------------------
// 命令：list / status / revoke
// ---------------------------------------------------------------------------

function isShareUnavailableError(err) {
  if (!(err instanceof CliError)) return false;
  if (err.httpStatus === 401 || err.httpStatus === 403 || err.httpStatus === 404 || err.httpStatus === 410) {
    return true;
  }
  return ['not_found', 'gone', 'unauthorized', 'forbidden'].includes(err.code);
}

async function commandList(flags) {
  const stateDir = stateDirOf(flags);
  const state = await loadState(stateDir);
  const entries = Object.values(state.shares)
    .filter((entry) => entry && typeof entry.id === 'string')
    .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));

  const output = [];
  for (const entry of entries) {
    const origin = shareOrigin(entry.url);
    try {
      const requestUrl = entry.ownerToken
        ? `${origin}/api/shares/${entry.id}?t=${encodeURIComponent(entry.ownerToken)}`
        : `${origin}/api/shares/${entry.id}/public`;
      const { data } = await requestJson(requestUrl);
      output.push({
        id: entry.id,
        url: entry.url,
        kind: data.kind ?? entry.kind,
        mode: data.mode ?? entry.mode,
        title: data.title ?? entry.title,
        password: entry.password ?? null,
        status: data.status ?? null,
        available: true,
        createdAt: entry.createdAt ?? null,
        expiresAt: data.expiresAt ?? entry.expiresAt ?? null,
        downloads: data.downloads ?? null,
        maxDownloads: data.maxDownloads ?? null,
        downloadsLeft: data.downloadsLeft ?? null,
        burnAfterRead: data.burnAfterRead ?? null,
        totalBytes: data.totalBytes ?? null,
        fileCount: Array.isArray(data.files) ? data.files.length : 0,
        transfer: entry.transfer ?? null,
      });
    } catch (err) {
      const error = toCliError(err);
      if (!isShareUnavailableError(error)) throw error;
      if (flags.all) {
        output.push({
          id: entry.id,
          url: entry.url,
          kind: entry.kind,
          mode: entry.mode,
          title: entry.title,
          password: entry.password ?? null,
          available: false,
          error: { error: error.code, message: error.message },
          createdAt: entry.createdAt ?? null,
          expiresAt: entry.expiresAt ?? null,
          transfer: entry.transfer ?? null,
        });
      }
    }
  }
  printJson(output);
}

async function commandStatus(flags, positionals) {
  const ref = positionals[0];
  const fallbackOrigin = isFullShareUrl(ref) ? null : await optionalOrigin(flags);
  const { origin, id } = parseShareRef(ref, fallbackOrigin);

  const stateDir = stateDirOf(flags);
  const state = await loadState(stateDir);
  const entry = state.shares[id] ?? null;

  let meta;
  if (entry?.ownerToken) {
    // 有 ownerToken 就用 owner 身份看真实元数据（含已撤销前的状态）
    meta = (await requestJson(
      `${origin}/api/shares/${id}?t=${encodeURIComponent(entry.ownerToken)}`,
    )).data;
  } else {
    meta = (await requestJson(`${origin}/api/shares/${id}/public`)).data;
  }

  printJson({
    ...meta,
    url: `${origin}/s/${id}`,
    password: entry?.password ?? null,
    transfer: entry?.transfer ?? null,
  });
}

async function commandRevoke(flags, positionals) {
  const ref = positionals[0];
  const fallbackOrigin = isFullShareUrl(ref) ? null : await optionalOrigin(flags);
  const { origin, id } = parseShareRef(ref, fallbackOrigin);

  const stateDir = stateDirOf(flags);
  const state = await loadState(stateDir);
  const entry = state.shares[id] ?? null;

  const ownerToken = flags['owner-token'] !== undefined
    ? String(flags['owner-token'])
    : entry?.ownerToken;
  if (!ownerToken) {
    throw new CliError('owner_token_required', '本地没有该分享的 ownerToken，请用 --owner-token <令牌> 指定');
  }

  const { data } = await requestJson(`${origin}/api/shares/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ownerToken}` },
  });

  printJson({
    ok: true,
    revoked: data?.revoked !== false,
    alreadyRevoked: data?.alreadyRevoked === true,
  });
}

// ---------------------------------------------------------------------------
// 内部命令：__relay-send（后台 P2P 发送子进程）
// ---------------------------------------------------------------------------

async function commandRelaySend(flags) {
  if (flags.id === undefined || String(flags.id) === '') throw usageError('__relay-send 需要 --id');
  const id = String(flags.id);
  const stateDir = stateDirOf(flags);
  const timeoutSeconds = parseTimeout(flags.timeout, DEFAULT_P2P_TIMEOUT_SECONDS);
  const log = (message) => {
    process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
  };

  log(`开始 P2P 后台发送：分享 ${id}，最长等待 ${timeoutSeconds} 秒`);
  try {
    const result = await runRelaySend({ stateDir, id, timeoutSeconds, log });
    log(`发送完成，共 ${result.bytes} 字节`);
  } catch (err) {
    const error = toCliError(err);
    await updateTransfer(stateDir, id, {
      status: 'failed',
      error: error.message,
    }).catch(() => {});
    process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
    log(`发送失败：${error.code} ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function handleFatal(err) {
  const error = toCliError(err);
  process.stderr.write(`${JSON.stringify({ error: error.code, message: error.message })}\n`);
  process.exitCode = error.exitCode ?? 1;
}

async function main() {
  const { command, positionals, flags } = parseArgv(process.argv.slice(2));

  if (flags.version) {
    process.stdout.write('kuaichuan Skill CLI 1.0.0\n');
    return;
  }
  if (flags.help || command === null || command === 'help') {
    process.stdout.write(HELP_TEXT);
    return;
  }

  switch (command) {
    case 'setup':
      await commandSetup(flags);
      return;
    case 'info':
      await commandInfo(flags);
      return;
    case 'send-text':
      await commandSendText(flags, positionals);
      return;
    case 'send-file':
      await commandSendFile(flags, positionals);
      return;
    case 'recv':
      await commandRecv(flags, positionals);
      return;
    case 'list':
      await commandList(flags);
      return;
    case 'status':
      await commandStatus(flags, positionals);
      return;
    case 'revoke':
      await commandRevoke(flags, positionals);
      return;
    case '__relay-send':
      await commandRelaySend(flags);
      return;
    default:
      throw usageError(`未知命令：${command}（运行 --help 查看可用命令）`);
  }
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // 输出被管道提前关闭（如 | head）时安静退出，不抛堆栈
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
  });
  main().catch(handleFatal);
}

// 导出纯函数，便于将来单测与复用（直接执行脚本时不影响主流程）
export {
  parseArgv,
  parseShareRef,
  sanitizeRelPath,
  buildCreateBody,
  normalizeOrigin,
  loadState,
  saveState,
};
