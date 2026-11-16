# 架构

magpie-aihub 是 Magpie 的消费端供应商插件：用用户自己的 AIHub 分组 Key 发送模型请求，在倍率、目录状态和进程内延迟记录范围内选组。供应商 ID 为 `aihub-auto`，远端固定为 `https://aihub.top`；插件不启动 Web 服务器。

本文来自代码阅读，未连接真实 Magpie 主机或 AIHub 账号，未验证远端接口契约、费用和实际模型可用性。

## 模块与运行边界

| 模块 | 输入 → 输出 / 状态 |
| --- | --- |
| [入口](../index.mjs) | 注册 `config`、`auth`、`provider.models`、`chat.headers` 钩子；按认证包 `instanceId` 缓存 Account / Router，最多 32 个实例 |
| [配置](../src/config.mjs) | 校验非敏感 options；解析手工分组 Key JSON；生成宿主模型配置 |
| [账户](../src/account.mjs) | 读取目录、刷新登录令牌、发现模型、恢复或创建专用 Key；认证变化通过 Magpie `client.auth.set` 保存 |
| [API 适配](../src/api.mjs) | 固定 AIHub origin 的 GET / POST；15 秒超时、拒绝重定向、解析 JSON / 列表 / 目录状态 |
| [路由](../src/router.mjs) | 校验请求、筛组、排序、会话亲和、有限重试、转交响应流；内存保存亲和 / 冷却 / 延迟 / 锁 |
| [取消等待](../src/async.mjs) | 调用方可中止等待共享刷新或变更队列；不为此启动第二次共享操作 |
| [设置页](../ui/app.js)、[页面](../ui/index.html) | 沙箱 UI 通过 Magpie bridge 读写当前插件 options、读取 `providers:list`；不接收凭据，不直接请求 AIHub |
| [清单](../package.json) | ESM；声明 Node ≥22，使用内置 crypto、Fetch、Web Streams；未声明外部依赖。AI SDK 包名是交给宿主的配置标识 |

服务端钩子在可信 Magpie / Bun 宿主内运行，没有插件自带沙箱；UI 的桥接权限不限制这些钩子的网络和认证操作。当前设计按一个宿主进程使用，不保证多进程共享状态或并发一致性。

## 认证与请求路径

1. 用户在宿主认证表单导入 Key，或提交邮箱 / 密码登录 AIHub。密码仅用于本次登录，不进入保存包。
2. 插件返回 `type: success` 与 JSON 字符串 `key`，由 Magpie auth API 保存；后续令牌 / Key / pending 变化调用 `client.auth.set`。保存队列使用代次标记，较早成功不能清除较新失败的 dirty 状态。底层是否加密取决于宿主，插件不保证加密。
3. 宿主 `auth.loader` 读取包，选择对应 Account / Router。每次 fetch 和后续保存都重新读取当前认证并比对 instanceId，已切换 / 断开的旧连接会被拒绝。内部占位 apiKey 不是真实凭据；实际分组 Key 仅在服务端构造 AIHub Authorization。
4. `chat.headers` 注入宿主 session ID；Router 用路径、模型和 ID 的 SHA-256 建立内存亲和。该内部头不转发到 AIHub。
5. 宿主模型请求 → Router → 账户目录与 Key → AIHub `/v1/responses` 或 `/v1/chat/completions` → 原始响应流 → 宿主。

没有应用用户角色、数据库或 RLS；本地访问权来自宿主提供的插件上下文和认证，远端账号 / Key 权限由 AIHub 执行。详见 [权限](permissions.md) 和 [流程](flows.md)。

## 已知约束与风险

| 事实与影响 | 代码证据 |
| --- | --- |
| 倍率上限是名义筛选阈值，不是金额预算、余额或远端 Key 配额；`0` 只允许倍率为 0 的组。手工倍率是用户声明 | [settings / manualBundle](../src/config.mjs)、[eligible](../src/router.mjs) |
| 手工 Key 不读取账号目录 / 检测状态；`requirePassed: true` 会排除这些无 passed 证据的候选 | [loadCatalogue](../src/account.mjs)、[eligible](../src/router.mjs) |
| 账号目录和 `/v1/models` 是读取结果，不保证推理可用；默认允许未知 available / 未通过检测的状态，显式失败会排除 | [normalizeHall / groupCandidate](../src/api.mjs)、[modelIds](../src/account.mjs) |
| 创建前先保存 pending；不确定结果保留 pending 并阻止盲目重建。仅恢复当前实例精确名称，不接管其他 Key；不删除或改写远端 Key | [keyFor](../src/account.mjs) |
| 已知 expires 临近到期且有 refresh 时，准备新组 Key 前主动刷新；未知到期时，创建 POST 即使收到 401 也保留 pending 并停止，不重试创建 | [keyFor](../src/account.mjs) |
| 当前认证 instanceId 检查减少旧连接误写；宿主 auth API 无 CAS，若重连发生在检查与写入之间仍有残余竞态，不能保证原子隔离 | [accountSaver](../src/account.mjs)、[loader](../index.mjs) |
| 首块交给宿主前的失败可能换组，远端此前仍可能计费；首块之后中断只报错，不重放 | [fetch](../src/router.mjs) |
| `totalTimeoutMs` 包括可取消的 body 缓冲与排队等待，在读到首块后清除，不是完整流时长上限 | [boundedBody / fetch](../src/router.mjs)、[waitFor](../src/async.mjs) |
| `previous_response_id` / `conversation` 被拒绝；客户端须传完整历史。亲和、锁、缓存只在本进程内，重载丢失 | [Router](../src/router.mjs) |
| 动态模型上下文 / 输出上限和 cost=0 是宿主展示占位，不能当作真实模型能力或免费承诺 | [provider.models](../index.mjs) |

无定时或后台作业：只在使用时惰性刷新目录，不生成 cron 文档。无邮件、公开 SEO 路由或嵌入式代理，不生成相应条件文档。自动化仅包含可选专用 Key 创建与请求路由，见 [自动化](automation.md)。

## Related Documents

- [权限与副作用流程](flows.md)
- [权限矩阵](permissions.md)
- [配置与凭据](variables.md)
- [自动化边界](automation.md)
- [测试覆盖映射](tests.md)
