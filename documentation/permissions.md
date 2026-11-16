# 权限

插件没有应用用户角色、租户 claim、数据库表或 RLS。宿主开放页面、桥接与认证；服务端使用宿主认证包，AIHub 决定账号令牌和 Key 的远端权限。本表映射 v0.2.1 预发布代码；真实生产 / 账号联调未验证，local mock 与 Edge 合成代理不等于六平台实测。

## 执行主体

| 主体 / 权限来源 | 实际作用域 |
| --- | --- |
| 设置页用户 | 经 Magpie bridge 操作当前插件非敏感 options；插件不自行判断管理员角色 |
| UI 沙箱 | options.get / options.set、声明的 providers:list 与 bridge.service 导航；不读取 auth、不直接 fetch AIHub |
| 可信服务端钩子 | Magpie / Bun 进程，无本插件沙箱；能用 client.auth.set、网络和运行时；UI 权限清单不是服务端限制 |
| manual 认证 | 用户提交 groupId / platform / key / multiplier / 可选 models；无账号 access / refresh，Key owned=false；旧包缺 platform 默认 openai |
| managed 认证 | access / refresh 与专用 Key；instanceId 区分实例；fetch / 保存重新比对当前 instanceId，不是抗伪造 claim |
| 页面服务访问方 | 仅 loopback 页面与 GET 快照；要求精确 Host、Origin 缺省或 null、无 body 与进程级页面 token；不授予写配置、推理或建 Key 权限 |
| AIHub | 校验管理 Bearer、分组 Bearer 或原生 Gemini x-goog-api-key；仓库不能证明远端隔离、配额或实际权限 |

证据：[清单](../package.json)、[设置页](../ui/app.js)、[认证与服务启动](../index.mjs)、[页面服务](../src/service.mjs)。

## 资源 × 操作矩阵

| 资源 / 操作 | UI | manual 服务端 | managed 服务端 | 拒绝或限制位置 |
| --- | --- | --- | --- | --- |
| 当前插件 options | bridge 读写 | 校验后加载 | 校验后加载 | [settings](../src/config.mjs)：未知键/非法值拒绝 |
| 供应商列表 | providers:list | 无需操作 | 无需操作 | [UI](../ui/app.js)：仅展示，失败不阻止保存 |
| 认证 JSON | 无入口 | 初次授权返回包 | 授权/刷新/Key 变化保存 | [accountSaver](../src/account.mjs)：断开、不同 instanceId、缺保存 API 拒绝 |
| 已加载连接推理 | 经宿主调用 | 比对当前认证后允许 | 同左 | [loader](../index.mjs)：旧连接拒绝 |
| 登录 / refresh | 无入口 | 不调用 | 允许，远端校验 | [API](../src/api.mjs)、[账户](../src/account.mjs)：2FA/缺令牌失败；GET 可刷新后重试；创建 POST 不重放 |
| 目录 / rates / 大厅 | 无直接入口 | 使用导入数据 | GET 允许 | [目录](../src/account.mjs)：六平台库存与可路由候选区分 |
| Key 列表 | 无入口 | 不调用 | GET 分页 | [账户](../src/account.mjs)：100 页上限 |
| 恢复专用 Key | 无入口 | 只用导入 Key | 当前实例精确名称+组+active+唯一 | [keyFor](../src/account.mjs)：重复/pending 未解决拒绝 |
| 创建专用 Key | 可保存开关 | 禁止 | 默认关闭，须 autoCreateKeys=true 且池未满 | [keyFor](../src/account.mjs)：先保存 pending 才单次 POST；未知结果不重建 |
| DELETE / PUT Key、付费探测 | 无入口 | 无实现 | 无实现 | [API](../src/api.mjs)、[账户](../src/account.mjs)：不设置远端金额配额 |
| /v1/models | 无直接请求 | 已有 Key GET / 声明 models | 已有 Key GET | [discover](../src/router.mjs)：发现不建 Key，不保证推理可用 |
| 六平台推理 POST | 经宿主模型调用 | 已导入 Key | 已有/恢复/允许创建的 Key | [Router](../src/router.mjs)、[平台](../src/platforms.mjs)：同平台同模型；Gemini responses/gemini，其余 responses/chat |
| 其他 URL / query / 方法 | 无入口 | 拒绝 | 拒绝 | [Router](../src/router.mjs)：固定 origin、精确路径；仅原生 Gemini 流式可选 alt=sse |
| 监控 GET /snapshot | 服务页面读取 | 读已导入目录/状态 | 可按需远端 GET 目录，可能刷新/保存令牌 | [快照](../src/telemetry.mjs)、[页面服务](../src/service.mjs)：不推理、不建 Key；无原始 auth/body/session |

## 凭据与请求隔离

- 静态设置页只读写非秘密 options；真实凭据在宿主认证表单和 auth API JSON 包，底层加密依赖宿主。
- 路由重建请求头，只保留 accept / openai-beta，注入分组 Authorization 或原生 Gemini x-goog-api-key；不透传宿主 Authorization、Cookie、内部平台/会话头。非 OpenAI platform::model 在上游前剥离命名空间。见 [Router](../src/router.mjs)。
- platforms、组名单、倍率是路由策略，不能撤销远端 Key 权限。manual 倍率是用户声明，缺大厅检测证据时 requirePassed 会排除全部候选。见 [筛选](../src/router.mjs)。
- Key 准备错误使用稳定 error.code / 安全 message，不返回原始管理响应；未知创建结果停止、不盲目重建。见 [错误](../src/errors.mjs) 与 [自动化](automation.md)。
- 锁与状态限单进程；保存代次保护 dirty，instanceId 拒绝已观察到的旧认证写入；宿主无 CAS，检查与写入之间重连仍有竞态。见 [账户](../src/account.mjs)。
- 监控仅返回白名单脱敏数据，缺失指标 null，最近 100 条内存记录不是持久审计。页面 token 随进程生成，不是 AIHub Key。见 [页面服务](../src/service.mjs)。

`monitorPort=19871` 仅为未生产分配的默认候选。Cloud 只批准四个静态资源，未批准 page.service 新路由；Edge 合成代理通过不赋予生产权限。opc-agent 生产私有路径拒绝不可绕过。

顺序与副作用见 [流程](flows.md)，数据/轮换见 [配置与凭据](variables.md)，验证范围见 [验证记录](tests.md)。外部平台接口只按公开代码核对，不作六平台实测保证。
