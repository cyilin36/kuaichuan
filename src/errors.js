/**
 * 统一错误类型。对外只暴露 code 与 message，堆栈只写日志。
 */

export class AppError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {number} httpStatus HTTP 状态码
   * @param {string} message 面向用户的中文提示
   * @param {unknown} [details] 额外细节（不得含敏感信息）
   */
  constructor(code, httpStatus, message, details) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  toBody() {
    const body = { error: this.code, message: this.message };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }
}

export const badRequest = (message = '请求参数不正确', details) =>
  new AppError('bad_request', 400, message, details);

export const unauthorized = (message = '请重新打开分享链接或输入密码') =>
  new AppError('unauthorized', 401, message);

export const forbidden = (message = '密码错误') => new AppError('forbidden', 403, message);

export const notFound = (message = '分享不存在或已被删除') =>
  new AppError('not_found', 404, message);

export const gone = (message = '分享已失效') => new AppError('gone', 410, message);

export const payloadTooLarge = (message = '超过大小限制') =>
  new AppError('payload_too_large', 413, message);

export const unsupportedMediaType = (message = '不支持的请求类型') =>
  new AppError('unsupported_media_type', 415, message);

/** 中继等待对端接入超时 */
export const relayTimeout = (message = '等待接收方接入超时') =>
  new AppError('relay_timeout', 504, message);

/** 暂存空间不足 */
export const insufficientStorage = (message = '服务器暂存空间不足') =>
  new AppError('insufficient_storage', 507, message);

export const conflict = (message = '当前状态无法完成此操作', details) =>
  new AppError('conflict', 409, message, details);

export const internal = (message = '服务器出错了，请稍后重试') =>
  new AppError('internal_error', 500, message);

export const configError = (message) => new AppError('bad_config', 500, message);
