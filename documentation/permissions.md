# 权限

本插件没有应用用户角色、租户 claim、数据库表或 RLS。宿主负责开放插件页面、桥接与认证入口；服务端使用宿主传入的认证包，AIHub 决定账号令牌和分组 Key 的远端权限。本表是代码边界映射，未经过真实主机 / 账号验证。

## 执行主体

| 主体 / 权限来源 | 实际作用域 |
| --- | --- |
| 插件设置页用户 | 经 Magpie bridge 操作当前插件非敏感 options；插件没有自行判断管理员角色 |
| UI 沙箱 | `options.get` / `options.set`，以及清单声明的 `providers:list`。权限由宿主执行；本页不含登录、auth 读取、AIHub fetch 或远端监控入口 |
| 可信服务端钩子 | 在 Magpie / Bun 进程执行，无本插件沙箱。能使用宿主 `client.auth.set`、网络和内置运行时能力；UI 权限清单不是服务端限制 |
| manual 认证 | 由用户提交 groupId / key / multiplier / 可选 models；没有账号 access / refresh；Key 标记 `owned: false` |
| managed 认证 | 登录返回的 access / refresh 与插件专用 Key；instanceId 区分本地运行实例。loader fetch / 后续保存重新读取并比对当前 instanceId；不是可抵御伪造的安全 claim |
| AIHub | 校验 Bearer 令牌 / 分组 Key；本仓库不能证明远端账号隔离、Key 配额或权限细节 |

证据：[清单](../package.json)、[设置页调用](../ui/app.js)、[认证加载](../index.mjs)。

## 资源 × 操作矩阵

| 资源 / 操作 | UI | manual 服务端 | managed 服务端 | 拒绝或限制位置 |
| --- | --- | --- | --- | --- |
| 当前插件 options 读写 | 允许，经 bridge | 加载并校验 | 加载并校验 | [UI](../ui/app.js)、[settings](../src/config.mjs)：未知键 / 非法值拒绝 |
| 宿主供应商列表读取 | `providers:list` | 无此操作需要 | 无此操作需要 | [providerSummary](../ui/app.js)：仅展示，失败不阻止保存 |
| 认证 JSON 包保存 | 无入口 | 初次授权返回包 | 授权 / 刷新 / Key 状态变化保存 | [accountSaver](../src/account.mjs)：无 client.auth.set、断开或当前 instanceId 不同则失败 |
| 已加载连接推理 | 无直接入口 | 比对当前认证后可调用 | 比对当前认证后可调用 | [loader](../index.mjs)：旧实例连接拒绝，要求重新加载 |
| 账号登录 / refresh | 无入口 | 不调用 | 允许，AIHub 校验 | [login](../src/api.mjs)、[call / keyFor](../src/account.mjs)：2FA / 无令牌失败；GET 遇 401 可刷新；创建前已知临近到期则先刷新；创建 POST 不重放 |
| 账号目录 / rates / 大厅读取 | 无入口 | 使用导入数据 | GET 允许 | [loadCatalogue](../src/account.mjs)：只接纳限定形态 / 状态 |
| 远端 Key 列表 | 无入口 | 不调用 | GET 分页允许 | [ownRemoteKeys](../src/account.mjs)：100 页上限 |
| 恢复专用 Key | 无入口 | 只用导入 Key | 仅当前实例精确名称 + group_id + active + 唯一 | [keyFor](../src/account.mjs)：不采用其他名称，重复或 pending 未解决则失败 |
| 创建专用 Key | 无入口；可保存开关 | 禁止 | 默认关闭，须 autoCreateKeys=true 且池未满 | [keyFor](../src/account.mjs)：先保存 pending 才 POST；未知结果含 401 不盲目再建 |
| DELETE / PUT Key、付费探测 | 无入口 | 无实现 | 无实现 | [API 方法](../src/api.mjs)、[Key 创建](../src/account.mjs)：只有 GET / POST；不设置远端金额配额 |
| `/v1/models` | 无直接请求 | 分组 Bearer Key GET / 导入 models | 已有 Key GET | [modelIds](../src/account.mjs)、[discover](../src/router.mjs)：发现不创建 Key，结果不保证推理可用 |
| 推理 POST | 经宿主模型调用 | 用已导入 Key | 用已有 / 恢复 / 已允许创建 Key | [fetch](../src/router.mjs)：精确 origin / 路径 / 方法、body 限额、候选筛选；禁止 server-side continuation |
| 任意 URL / query / 其他方法 | 无入口 | 拒绝 | 拒绝 | [URL 检查](../src/router.mjs)：400 / 405 |

## 凭据与请求隔离

- UI 只读写 options；真实凭据在宿主认证表单和 auth API JSON 包中，不打包到静态页面。包包含令牌 / Key，底层加密依赖宿主，不作保证。
- 路由为上游重新建立 headers：只保留 `accept` / `openai-beta`，Authorization 使用被选中的分组 Key；不透传宿主 Authorization、Cookie 或内部会话 ID。见 [请求头白名单](../src/router.mjs)。
- `allowedGroups` / `excludedGroups` / `maxMultiplier` 是路由筛选，不能撤销远端 Key 权限。manual multiplier 是用户声明；manual 没有检测监控，开启 `requirePassed` 将无候选。见 [eligible](../src/router.mjs)。
- 本地实例内锁只保护当前 Account / Router；不保证多个宿主进程同时使用同一认证包时安全去重。保存代次防止较早成功掩盖较新失败；instanceId 检查防止已观察到的旧认证写入，但宿主无 CAS，检查与写入之间重连仍存在竞态。见 [Account / accountSaver](../src/account.mjs)、[会话锁](../src/router.mjs)。

顺序与副作用见 [流程](flows.md)，认证数据和轮换见 [配置与凭据](variables.md)，验证范围见 [测试覆盖映射](tests.md)。
