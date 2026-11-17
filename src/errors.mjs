// Stable local errors; never expose management responses or credentials.
const SIGN_IN_REQUIRED = 'AIHub 登录已失效，请重新连接账户。';
const SESSION_EXPIRED = 'AIHub 登录已失效（续期被拒绝），请在 Magpie 里重新登录该账户。';

export class KeyError extends Error {
  constructor(code, message) { super(message); this.name = 'KeyError'; this.code = code; }
}

// A rejected refresh means the stored session itself is gone: every management
// read will answer 401 until the account signs in again. Keeping it apart from a
// plain management 401 is what lets callers say "sign in again" instead of
// reporting an ambiguous permission problem.
export class SessionExpired extends Error {
  constructor(message = SESSION_EXPIRED) {
    super(message); this.name = 'SessionExpired'; this.status = 401; this.code = 'session_expired';
  }
}

export function keyFailure(error) {
  if (error instanceof KeyError) return { code: error.code, message: error.message };
  if (error instanceof SessionExpired) return { code: 'key_session_expired', message: error.message };
  if (error?.status === 401) return { code: 'key_sign_in_required', message: SIGN_IN_REQUIRED };
  if (error?.status === 403) return { code: 'key_access_denied', message: 'AIHub 拒绝访问分组 Key，请检查账户权限或手工导入 Key。' };
  if (error?.status === 429) return { code: 'key_rate_limited', message: 'AIHub Key 管理接口限流，请稍后重试。' };
  return { code: 'key_preparation_failed', message: '无法准备分组 Key；请检查 AIHub 连接和待确认的创建记录。' };
}
