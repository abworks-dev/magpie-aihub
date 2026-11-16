// Stable local errors; never expose management responses or credentials.
export class KeyError extends Error {
  constructor(code, message) { super(message); this.name = 'KeyError'; this.code = code; }
}
export function keyFailure(error) {
  if (error instanceof KeyError) return { code: error.code, message: error.message };
  if (error?.status === 401) return { code: 'key_sign_in_required', message: 'AIHub 登录已失效，请重新连接账户。' };
  if (error?.status === 403) return { code: 'key_access_denied', message: 'AIHub 拒绝访问分组 Key，请检查账户权限或手工导入 Key。' };
  if (error?.status === 429) return { code: 'key_rate_limited', message: 'AIHub Key 管理接口限流，请稍后重试。' };
  return { code: 'key_preparation_failed', message: '无法准备分组 Key；请检查 AIHub 连接和待确认的创建记录。' };
}
