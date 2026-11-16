# 测试覆盖与验收记录

## 当前证据

2026-11-17 02:14–02:15 +08，本地 Windows / Node 24.22.1 对 v0.2.1 执行 `node --test`：182 项测试通过，失败、取消、跳过均为 0（含嵌套计数）。路由与账号测试使用模拟 fetch、模拟宿主和内存流；页面服务测试启动真实回环 HTTP 服务并提供合成快照。不含真实凭据或付费模型调用。`npm run check` 对入口、服务端模块与 UI 脚本逐个做语法检查，exit 0。`npm pack --dry-run` 包含 23 个预期文件、99.1 kB，未包含测试凭据或隔离宿主目录。

## v0.2.1 单页监控、页面服务与 Key 错误

设置与监控合并为一份页面，由 page.service 在 127.0.0.1 提供，Magpie 的静态页只保留 bridge。测试覆盖：服务的精确 Host、Origin 缺省或 `null`、GET/HEAD-only、无 body、端口冲突与参数校验；`/snapshot` 的进程级 token（缺失/错误 403）、预检只放行 GET + 该头、`Access-Control-Allow-Origin: null`、响应体上限与端口占用拒绝；服务提供的 HTML 带 token 占位替换和 `../bridge.js` 重写，且不落盘。VM 测试覆盖设置页的六平台、模型限制与端口保存，监控标签在静态页跳转服务、在服务页同源读取快照、无 token 时不猜 URL、桌面版提示回环地址。

2026-11-17 01:40 +08 与本轮修改后，真实 Edge 经合成 Magpie service 代理加载合并页：`passed: true`、`rows: 1`、`filters: 2`、`kpis: 4`、`reads: 1`、`error: false`。同轮 Edge 设置页回归：`saves: 1`，成功状态为“已保存。”，控件恢复，exit 0。桥接与快照为合成对象，未登录用户实例；这不是生产 Cloud service 授权或真实 Magpie 浏览器代理验收。

截图检查使用本机 Edge headless 1200×1500 对服务页 `/` 与 `/#monitor` 各拍一张，人工核对布局、表格、筛选与状态标签；视觉检查不替代真实数据与宿主主题验收。

Key 错误测试验证稳定本地错误码不反射管理端响应，并覆盖创建结果不完整、同名重复、错误组、停用 Key 和重载后的 pending；未知创建不再次 POST。

## 官方宿主隔离检查

2026-11-16 20:18–20:21 +08，本机 Windows 执行官方 `v0.1.3250` CLI，文件 SHA256 为 `1991382e8e0fefee01c20b256d6be53efc3118f527b0579fd850f601b51d2ae4`，与官方 `SHA256SUMS` 一致。可执行文件旁 `.portable` 与独立 HOME/config/cache 隔离；关闭账号发现，未修改真实 Magpie 实例。

实际通过：从本地包加载插件、识别配置页权限、读取非秘密 options、合成分组 Key 表单登录、显示已连接账户，以及为两个模型分别注册 `@ai-sdk/openai` / `@ai-sdk/openai-compatible`。初次真实检查发现 API 表单完成后还会索要额外 Key；已给两个认证方法补 `keyless: true`，复验通过，并加入回归断言。

2026-11-17 01:12–01:13 +08，使用同一固定官方 CLI、摘要和隔离环境，对 v0.2.0 复验通过：本地插件加载、合成分组 Key 登录、六个平台共 8 个模型注册，以及 `@ai-sdk/openai`、`@ai-sdk/openai-compatible`、`@ai-sdk/google` 三种 SDK 选择。检查不设置全局 loader baseURL，模型配置各自携带协议 URL。注册成功不证明实际 SDK 生成的推理请求端到端可用。

可重复脚本为 [magpie-host-smoke.ps1](../test/magpie-host-smoke.ps1)。2026-11-17 01:23–01:25 +08，提交 `5795e41`（tag `v0.2.0`）的 [验证运行](https://github.com/abworks-dev/magpie-aihub/actions/runs/43917943251) 中 `node`、`bun`、`magpie-host` 三个任务均通过；`magpie-host` 在 Windows 上执行固定官方宿主、两个浏览器检查与上述八模型注册。旧提交的 CI 成功不能替代本版记录；后续提交须以各自 Actions 结果为准。v0.2.1 的宿主检查在发布前以同一脚本复验，结果随发布提交记录更新。所有隔离宿主检查均未发送推理或真实 AIHub 登录，不覆盖 Go 网关完整请求链、浏览器渲染或生产容器部署。

## 浏览器沙箱保存回归

2026-11-16，用户在页面已打开后报告点击保存无反应。旧版的 VM 测试直接触发表单 submit 处理器，遗漏浏览器对沙箱表单的限制。用真实 Edge、独立临时用户目录、实际 UI 文件和模拟 bridge，在 `sandbox="allow-scripts"`、`form-action 'none'` 下复现：点击后保存调用0次，状态仍为“选项已载入”。

0.1.2 移除原生 form 提交，改为普通按钮显式调用 options bridge；不放宽 iframe 或 CSP。0.2.1 起页面没有原生 `form`，保存按钮为 `type=button`。[browser-ui-smoke.mjs](../tooling/browser-ui-smoke.mjs) 在本机回环临时端口加载隔离页面、实际点击按钮，断言恰好保存一次、输入值正确、出现成功状态且控件恢复；结束后关闭浏览器进程树和 HTTP 服务。测试不登录实际 Magpie，不调用 AIHub，不证明宿主 options 的真实持久化或完整视觉质量。

## 新账户模型发现与站点图标

0.1.3 修复刚登录账户的认证包中 `keys: []` 导致旧发现逻辑永远返回空列表的问题。新逻辑读取账号可用分组、实际倍率与大厅模型卡片；仅在缺少卡片时使用已启用且合法的有限模型限制作为候选。所有候选继续应用倍率、允许/排除、平台、健康、检测与模型限制；可用的已有专用 Key 仅补充所属合格分组。没有证据时给出明确错误，与合法筛选后为空区分。

新增 [discovery.test.mjs](../test/discovery.test.mjs) 与入口级 provider hook 回归：零 Key 新账户取得模型时仅发三个目录 GET，没有创建/枚举 Key 或推理请求；覆盖无效限制、失败卡片、缺少证据、目录失败、冷却、已有专用 Key 和手工模式。401 后既有认证刷新机制仍可能 POST refresh；不把刷新写操作称为纯 GET。

官方图像从 `https://aihub.top/favicon.ico` 返回的站点 HTML 的 PNG favicon 取得，而非将 HTML 当图像。20448 bytes、1182×1182，SHA256 `4ca27ef38578050dbf72af67769efd77fd3cba146916f60bcb6f1198b93793f0`。元数据与设置页内嵌同一 data URI，测试核对一致及摘要；[update-branding.mjs](../tooling/update-branding.mjs) 仅在图像仍匹配已审核摘要时更新。无需增加 Cloud 静态路径。宿主加载通过，生产 UI 的实际图标展示尚未确认。

## 行为 → 测试映射

| 行为与边界 | 测试文件 | 验证方式与限制 |
| --- | --- | --- |
| 倍率上限、零倍率、允许 / 排除、检测与模型筛选 | [router.test.mjs](../test/router.test.mjs)、[account.test.mjs](../test/account.test.mjs) | 模拟候选、异常倍率与目录；不证明实际账号倍率 |
| 会话亲和、容量边界、新会话选组、冷却与 Retry-After | [router.test.mjs](../test/router.test.mjs)、[review.test.mjs](../test/review.test.mjs) | 模拟时间 / 响应头，验证候选顺序与尝试次数；不证明提供方缓存命中 |
| 401 / 403 / 429 / 5xx 与网络、首块超时 | [router.test.mjs](../test/router.test.mjs) | 模拟推理；检查有限切换、普通调用错误不重试 |
| 首块后中断不重放、调用方取消 | [router.test.mjs](../test/router.test.mjs) | 可控制 Web Streams；未测试真实 SSE 代理、网络和 SDK 完整链路 |
| 固定 origin / 方法 / 路径、请求头白名单、body 上限 | [router.test.mjs](../test/router.test.mjs) | 检查出站请求，拒绝未支持路由和服务端状态续接 |
| 入站 body 阻塞、共享任务等待方取消 | [review.test.mjs](../test/review.test.mjs) | 卡住的流 / Promise 与 AbortSignal；验证等待期限和取消 |
| 新账户无 Key 模型发现、目录证据与策略过滤 | [discovery.test.mjs](../test/discovery.test.mjs)、[plugin.test.mjs](../test/plugin.test.mjs) | 模拟管理目录与实际 provider hook，核对只读发现；不证明在线目录结构永不变化 |
| 模型发现故障换候选 | [review.test.mjs](../test/review.test.mjs) | 撤销 Key 的模型读取失败后只在备用 Key 发推理 |
| 用户 API 包装、目录 v2 回退和倍率校验 | [account.test.mjs](../test/account.test.mjs) | MIT 公开适配器观察的字段形状；不能保证 AIHub 接口不变 |
| 令牌刷新与保存 | [account.test.mjs](../test/account.test.mjs)、[review.test.mjs](../test/review.test.mjs) | 模拟 401、持久化失败、重叠保存与账号更换；无宿主 CAS，检查后写入前的窄竞态未消除 |
| 创建前持久化、并发只建一次、未知结果不重建 | [account.test.mjs](../test/account.test.mjs) | 检查事件顺序和 POST 次数；不证明远端落实幂等键 |
| 精确实例 Key 恢复、池上限、不修改其他 Key | [account.test.mjs](../test/account.test.mjs) | 模拟 Key 列表和不完整响应；没有 DELETE / PUT 路径 |
| 插件导出、config / loader / models / chat.headers、keyless 声明 | [plugin.test.mjs](../test/plugin.test.mjs) | 模拟 hook；另用官方固定宿主核插件加载、表单认证与每模型 SDK，不覆盖完整推理 |
| 六平台命名空间、平台内精确模型 failover、Gemini 原生协议 | [platforms.test.mjs](../test/platforms.test.mjs)、[plugin.test.mjs](../test/plugin.test.mjs) | 合成目录及出站请求断言；未进行六平台真实计费调用 |
| 稳定 Key 错误码、管理响应脱敏、不完整创建和精确恢复 | [key-errors.test.mjs](../test/key-errors.test.mjs) | 模拟管理响应、重载和冲突，验证不重放创建 |
| 页面服务访问约束、token / CORS、只读快照、端口冲突 | [service.test.mjs](../test/service.test.mjs)、[telemetry.test.mjs](../test/telemetry.test.mjs) | 真实回环 HTTP + 合成快照；不覆盖生产 Cloud 路由或 Magpie 真实代理 |
| 合并页导航、同源快照渲染、六平台设置保存 | [ui.test.mjs](../test/ui.test.mjs)、[browser-monitor-smoke.mjs](../tooling/browser-monitor-smoke.mjs)、[browser-ui-smoke.mjs](../tooling/browser-ui-smoke.mjs) | VM 加真实 Edge 合成代理；不替代生产页面与真实数据 |
| 官方品牌图像一致与摘要 | [plugin.test.mjs](../test/plugin.test.mjs) | 比对元数据与页面图像；不代替生产渲染检查 |
| UI 配置保存、保留高级配置、bridge 缺失 / 保存失败 | [ui.test.mjs](../test/ui.test.mjs)、[browser-ui-smoke.mjs](../tooling/browser-ui-smoke.mjs) | VM 验校验和反馈；真实 Edge 验沙箱内点击保存，bridge 为模拟；未做生产持久化与完整视觉验收 |

## 可重复执行

```sh
npm run check
npm test
npm pack --dry-run
node tooling/browser-ui-smoke.mjs
node tooling/browser-monitor-smoke.mjs
```

没有外部测试依赖，不需要 `.env`、真实 Key、账号或联网模型。CI 的 Bun 任务执行 `bun test`；Windows 任务另跑两个 Edge 回归与官方宿主检查。

## 尚未验证

- 生产 Magpie 实例的安装、页面展示、浏览器密码提示和 UI bridge 保存；官方隔离 CLI 的识别 / 认证 / SDK 注册已经通过，不代表生产验收。实际会话 ID、完整 SDK 请求与 Go 网关链仍未验证。
- 页面服务在生产宿主的端口占用、宿主 service 代理与 `magpie web` 的真实转发；本地回环代理检查只证明对应路径。
- Magpie 多账号上下文及认证存储的加密、CAS、备份和重载行为。
- AIHub 真实登录 / 验证码 / 2FA、管理接口字段、模型目录、专属倍率和 Key 创建 / 列表返回完整 Key 的能力。
- 六平台的 Responses / Chat Completions、Gemini 原生协议的真实流、工具调用、长会话、取消与缓存行为。
- 生产监控端口分配、宿主 service 代理与 Cloud 路由；默认 19871 仅是候选，未因本地临时端口检查成为已分配端口。
- 实际费用、上游幂等、首块前重试是否产生重复计费、AIHub 后台自动改组的影响。
- 宿主重载会清空内存亲和；多进程共享同一认证包没有并发去重保证。共享目录 / 令牌刷新仍可能受首先发起者取消影响。

## 后续真实验收顺序

1. 在目标 Magpie 安装固定 ref `#v0.2.1`，先核对插件页面、合并后的监控标签与非敏感设置。
2. 导入两把已在 AIHub 设置有限额度、固定分组的测试 Key，关闭 `requirePassed`，填写准确倍率 / 模型。
3. 分别验证所用平台的 Responses / Chat / Gemini 原生协议与完整历史请求。少量真实推理可能计费，应在用户授权的费用范围内执行。
4. 核对会话保持、取消和受控故障。检查 AIHub 用量，不将模拟测试当作真实费用证明。
5. 账户模式先验证只读目录；如用户接受自动建 Key，再启用开关，检查专用名称、保存与恢复。没有确认远端状态时不要绕过 pending。

相关：[架构](architecture.md)、[流程](flows.md)、[权限](permissions.md)、[配置与凭据](variables.md)、[自动化](automation.md)。
