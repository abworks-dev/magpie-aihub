# 架构

magpie-aihub 是 Magpie 的消费端供应商插件：用用户自己的 AIHub 分组 Key 发送模型请求，在倍率、目录状态和进程内延迟记录范围内选组。供应商 ID 为 `aihub-auto`，远端固定 `https://aihub.top`。v0.3.1 预发布实现覆盖 openai / deepseek / zhipu / kimi / grok / gemini 六平台，仅同平台同模型 failover。

本文以代码阅读、local mock 与 Edge 合成代理为依据；真实生产联调、真实 AIHub 账号与计费推理尚未验证。外部平台接口只按公开文档/公开代码核对，不代表六平台均已实测。独立 MIT 实现，不复制许可不明代码。

## 模块与运行边界

| 模块 | 输入 → 输出 / 状态 |
| --- | --- |
| [入口](../index.mjs) | 注册 config、auth、provider.models、chat.headers 钩子并启动页面服务；按认证包 instanceId 缓存 Account / Router，最多 32 实例；重新登录时退掉旧实例；同一身份的 Key 交给新实例沿用，换账户不沿用 |
| [配置](../src/config.mjs) | 校验非敏感 options、平台与协议；解析手工 Key JSON；生成宿主模型配置 |
| [平台](../src/platforms.mjs) | 六平台标识、`platform::model` 命名空间、模型描述与协议/SDK/API base 映射 |
| [账户](../src/account.mjs) | 读取目录、刷新登录令牌、发现模型、恢复或创建专用 Key；受 maxKeysPerAccount 与 minBalance 约束，记录内存级 Key 事件；变化经 Magpie client.auth.set 保存 |
| [API 适配](../src/api.mjs) | 固定 AIHub origin 的 GET / POST；15 秒超时、拒绝重定向；六平台目录与指标归一化 |
| [路由](../src/router.mjs) | 请求校验、同平台同模型筛组、会话亲和、有限重试、流转交；内存保存亲和/冷却/延迟/锁/最近结果 |
| [余额](../src/billing.mjs) | 账户模式读取 /api/v1/auth/me、/api/v1/usage/stats、/api/v1/user/platform-quotas → 余额、消耗与平台限额；不读 Key 列表 |
| [密钥错误](../src/errors.mjs) | Key 准备稳定错误码与安全消息，不透出原始管理响应 |
| [快照](../src/telemetry.mjs) | 目录与进程状态 → 白名单监控数据；可按需刷新目录，不推理、不建 Key |
| [页面服务](../src/service.mjs) | 固定在 127.0.0.1 的 HTTP 服务：提供同一份页面与 GET /snapshot，注入进程级页面令牌，检查 Host / Origin / 方法 / body 并脱敏 |
| [取消等待](../src/async.mjs) | 调用方可中止共享刷新或队列等待，不为此重复启动共享操作 |
| [页面](../ui/index.html)、[脚本](../ui/app.js)、[样式](../ui/style.css) | 一份页面两处使用：Magpie 静态页经 bridge 读写非敏感 options；回环服务同源提供设置与只读监控，不接收账户凭据 |
| [清单](../package.json) | 无依赖 ESM，Node ≥22 / Magpie Bun；crypto、Fetch、Web Streams、HTTP；AI SDK 包名交由宿主解析 |

服务端钩子在可信 Magpie / Bun 宿主内运行，没有插件自带沙箱；UI 桥接权限不限制这些钩子的网络和认证操作。设计按单宿主进程使用，不保证多进程共享状态或并发一致性。

## 认证与请求路径

1. 用户在宿主认证表单导入 Key，或提交邮箱/密码登录。密码仅本次登录使用，不进入保存包。
2. 插件返回成功认证 JSON，由 Magpie auth API 保存；后续令牌/Key/pending 变化调用 client.auth.set。保存队列用代次标记，旧成功不能清除新失败的 dirty。底层加密依赖宿主。
3. auth.loader 读取包并选择 Account / Router；每次 fetch 和保存重新读取当前认证并比对 instanceId，拒绝已切换/断开的旧连接。占位 apiKey 不是凭据；真实分组 Key 仅在服务端构造 Authorization 或 x-goog-api-key。
4. 非 OpenAI 公共 ID 为 `platform::model`，OpenAI 保留原始 ID。chat.headers 注入内部平台/session 头；Router 用路径、平台模型、会话值哈希建立亲和，不转发内部头。
5. 宿主模型请求 → Router → 同平台同模型目录候选与 Key → AIHub Responses / Chat Completions 或原生 Gemini → 响应流。Gemini 允许 responses / gemini；其他平台 responses / chat；不做任意协议转换。

没有应用用户角色、数据库或 RLS；本地访问权来自宿主插件上下文与认证，远端账号/Key 权限由 AIHub 执行。详见 [权限](permissions.md) 和 [流程](flows.md)。

## 页面服务与只读监控

设置与监控共用一份页面。Magpie 提供静态页时只给 bridge 与 `providers:list`，且 CSP `connect-src 'none'` 让页面无法直接取数；页面上的监控标签会导航到插件自己的回环服务（`page.service`，`monitorPort` 默认 19871），或直接由服务提供同一文档。`magpie web` 会把该服务代理到插件页面路径下（Host 重写为回环、Origin 为 `null`），桌面版 Magpie 不代理，页面改为提示在本机打开 `http://127.0.0.1:<port>/`。

服务只监听 127.0.0.1，仅接受 GET/HEAD，要求精确 Host、Origin 缺省或 `null`、无请求体；`/snapshot` 还需要服务注入到页面 `<meta>` 的进程级令牌（`x-aihub-service-token`），响应带 `Access-Control-Allow-Origin: null`，因此沙箱页面可读而其他站点/第三方框架不可读。捷径：服务在 web 代理下被沙箱化，无法保证同源。

账户模式的快照还带余额卡：`/api/v1/auth/me` 的可用/冻结余额与充值总额、`/api/v1/usage/stats` 的累计请求与消耗、`/api/v1/user/platform-quotas` 的六平台日/月限额与用量，按 60 秒缓存读取；读取失败时沿用最多 10 分钟的旧快照，否则显示 `billing_unavailable` / `billing_access_denied` / `billing_sign_in_required` / `billing_session_expired`。余额只用于展示与 `minBalance` 建 Key 门限，不参与路由排序；`/api/v1/keys` 返回明文 Key，插件只在恢复本实例创建的 Key 时读取该列表，不做批量导出、不记录明文。

快照经过字段白名单、数量/大小限制和脱敏，不返回原始 auth、请求 body、session ID 或管理响应。最近路由最多 100 条，仅进程内存；缺失/未就绪指标为 null，不能当成零或健康证据。

“只读”指没有推理探测或建 Key：读取可能调用远端目录 GET，也可能因管理认证到期刷新令牌并保存。非可路由分组可出现在监控库存，标注排除原因，不意味着参与路由。监控不是持久审计日志。Cloud 目前仅批准四个静态资源，未批准 service 新路由；生产 opc-agent 私有路径拒绝不可绕过，不能把 Edge 合成代理通过写成生产可用。

## 已知约束与风险

| 事实与影响 | 代码证据 |
| --- | --- |
| 倍率上限不是金额预算、余额或远端 Key 配额；0 只允许名义倍率为 0 的组；manual 倍率为用户声明 | [配置](../src/config.mjs)、[路由](../src/router.mjs) |
| 手工 Key 不读取账号目录/检测；requirePassed=true 会排除缺少 passed 证据的候选 | [账户](../src/account.mjs)、[筛选](../src/router.mjs) |
| 目录、广告模型和 /v1/models 不保证推理可用；显式失败/不合格平台不可路由；默认未知状态仍可能可选 | [目录](../src/api.mjs)、[模型读取](../src/account.mjs) |
| 创建前先保存 pending；未知结果含 401 不重放；只恢复本实例精确名称/组的唯一 active Key，不删除或改绑 | [keyFor](../src/account.mjs) |
| 有 refresh 且已知 expires 临近时，准备新组 Key 前刷新；无到期证据不能保证创建不会遭遇认证失败 | [keyFor](../src/account.mjs) |
| 余额只用于展示与 `minBalance` 门限；接口不可用时跳过门限而不是推断余额，也不影响已有 Key 使用 | [余额](../src/billing.mjs)、[金额门限](../src/account.mjs) |
| instanceId 检查减少旧连接误写，但宿主 auth API 无 CAS，检查与写入之间重连仍有竞态 | [保存](../src/account.mjs)、[loader](../index.mjs) |
| 首块前重试可能重复计费；首块后中断只报错，不重放；Key 准备失败以稳定 code 停止 | [Router](../src/router.mjs)、[错误](../src/errors.mjs) |
| totalTimeoutMs 覆盖 body 缓冲/排队/首块前预算，读到首块后清除，不限制整个长流 | [路由](../src/router.mjs)、[waitFor](../src/async.mjs) |
| previous_response_id / conversation 拒绝；需完整历史；亲和、锁、缓存、监控结果重载丢失 | [Router](../src/router.mjs) |
| 动态模型上下文/输出和 cost=0 是展示占位；监控缺失指标 null；均不是能力、免费或健康承诺 | [模型](../index.mjs)、[快照](../src/telemetry.mjs) |

无定时后台作业：目录只在使用时刷新，不生成 cron 文档。无邮件、公开 SEO 路由或嵌入式代理，不生成对应条件文档。确定性 Key 创建、请求路由与按需监控见 [自动化](automation.md)。

## Related Documents

- [安装与首次验收](installation.md)
- [权限与副作用流程](flows.md)
- [权限矩阵](permissions.md)
- [配置与凭据](variables.md)
- [自动化边界](automation.md)
- [测试覆盖映射](tests.md)
