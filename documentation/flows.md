# 权限与副作用流程

代码阅读映射；未做真实主机 / 账号联调。静态访问规则见 [权限](permissions.md)，参数见 [配置与凭据](variables.md)。

## 1. 保存路由选项

**参与者 / 前提 / 结果：** 能打开当前插件页面的宿主用户；Magpie bridge 就绪；非敏感 options 保存到当前插件。

| 顺序与边界 | 检查 / 拒绝 | 副作用 |
| --- | --- | --- |
| UI → bridge `options.get` | 无 bridge / 超时则禁用表单；客户端只保留识别的非敏感键 | 读取当前选项，不读取 auth |
| 用户提交 → UI 校验 | 数字范围、分组正整数、模型 ID / 协议 / 重复检查；保存间隔至少 1100ms | 无效输入不发起写入 |
| UI 再读最新 options → `options.set(next)` | 保留有效高级选项与模型 context / output；桥接作用域由宿主执行 | 写当前插件 options；可能触发重载、清空内存亲和 |
| 等待保存结果 | 15 秒超时标为结果未知；要求重新打开核实，不自动重发 | 表单保留 |

证据：[UI 初始化 / 保存](../ui/app.js)、[服务端 settings](../src/config.mjs)。UI 校验不是服务端安全边界，服务端加载选项时再次校验；没有应用角色判断。

## 2. 导入凭据或账号登录

**参与者 / 前提 / 结果：** 自有 AIHub 账号或分组 Key 的用户，在宿主认证表单操作；获得 `aihub-auto` 认证 JSON 包。

| 路径与边界 | 检查 / 拒绝 | 数据变化 / 远端调用 |
| --- | --- | --- |
| 宿主表单 → 手工导入 | 1–32 项；groupId 正整数且唯一；非空 key；非负有限 multiplier；models 如有须为字符串数组 | 生成新 instanceId，`mode: manual`、`owned: false`；不调用账号登录 API |
| 宿主表单 → 服务端 → AIHub | `POST /api/v1/auth/login`；拒绝重定向 / 错误 JSON / 非成功 code；2FA 或无 access_token 则失败 | 发送邮箱 / 密码与空 turnstile_token；保存 access / refresh / expires / identity，不保存密码 |
| 服务端 → Magpie auth API | authorize 仅返回成功包或 failed；Account 检查 version / mode / keys | 宿主保存 JSON key；UI 不参与、不接收凭据 |
| 已加载连接 fetch / 后续保存 → 当前认证 | 重新读取当前 auth，比对 instanceId；已断开或切换则拒绝旧连接请求 / 保存 | 保存串行排队，以代次标记保护 dirty；宿主无 CAS，检查后重连仍可能竞态 |
| 管理 API 返回 401 → 刷新 | 有 refresh 且使用的 access 尚未被其他刷新替换才发起 / 合并刷新；等待可取消 | `POST /api/v1/auth/refresh` 后保存令牌；GET 可重试一次，带 body 的写操作不自动重放 |

证据：[auth / loader](../index.mjs)、[login / tokenFields](../src/api.mjs)、[Account.call / save / accountSaver](../src/account.mjs)。本地无角色 / claim 检查；AIHub 校验账号令牌权限，宿主控制认证表单与存储访问。

## 3. 发现模型与读取目录

**参与者 / 前提 / 结果：** 宿主模型发现或模型请求；有效认证；获得模型 ID 或候选组，不能据此认定推理已通过。

- `provider.models` 有显式 models 时直接使用配置；无认证不发现。managed 从可用分组与大厅广告模型发现，按倍率、组范围、检测、模型限制筛选；没有大厅模型时可用有效的非空组模型限制列表。目录缺少可识别模型证据且无已有 Key 补充时明确报错，不静默伪装为空目录。manual 保持读取前 `poolSize` 个已有 Key；不为下拉列表创建 Key。
- Key 自带 models 时直接使用；否则以分组 Bearer Key `GET /v1/models`，15 秒超时、拒绝重定向，要求 `data` 为数组；按组内存缓存 `refreshMs`。
- 请求所需目录在缓存过期后惰性读取。managed 并行 GET `/api/v1/groups/available`、`/api/v1/groups/rates`、`/api/v2/public/providers`；仅 public v2 返回 404 / 410 时回退 v1。
- 目录只接受 active / openai 且仍在大厅可见、无显式检测失败的组；倍率优先账号 rates，再 group，再大厅。刷新失败仅在 `maxStaleMs` 内使用旧快照，否则失败；调用方取消等待时不回退旧快照。
- manual 直接以保存 Key 生成候选，不读取账号倍率或检测状态；`requirePassed` 开启时缺乏 passed 证据会全部排除。

证据：[发现](../src/router.mjs)、[目录与模型读取](../src/account.mjs)、[目录解析](../src/api.mjs)、[waitFor](../src/async.mjs)。这些读取没有付费推理探测，也没有监控循环。

## 4. 准备专用 Key

**参与者 / 前提 / 结果：** 用户的模型请求触发 managed 账户 Key 准备；已有 Key 可直接使用，否则须可恢复或用户已开启 `autoCreateKeys`。

1. Account 实例内串行处理 Key 变更；队列等待可取消，未开始的已取消操作不会执行。已有本地组 Key 先处理未完成的保存。
2. 无 Key 时检查 managed 模式、池大小和 pending。待解决 pending 属于其他组时拒绝新建。
3. 有 refresh 且已知 expires 距今不超过 30 秒时，先刷新并保存认证；再分页 `GET /api/v1/keys?page=…&page_size=100`，最多 100 页。仅恢复 `magpie-aihub-{instanceId 前12字符}-g{groupId}` 精确名称、相同 group_id、active 的唯一 Key。重复则失败，其他 Key 不采用。
4. 有 pending 但未恢复到 Key，报告未知结果并停止；不会自动重建。无 pending 且未开启 autoCreateKeys 时拒绝创建。
5. 生成 UUID 幂等键，把 pending 先写入 Magpie auth；保存成功后才单次 `POST /api/v1/keys`，body 仅含 name / group_id，附 `Idempotency-Key`。未知到期情况下即使创建收到 401，也保留 pending 并停止，不刷新后重试创建。
6. 校验返回 key、id、group_id、名称；必要时重新列表恢复。完整结果加入 owned Key、清除 pending，再保存；失败保留可供核实的状态。

证据：[keyFor](../src/account.mjs)。无 DELETE / PUT、无远端 Key 配额设置；关闭自动创建不撤销已建 Key。取消等待不能证明已经发出的远端创建没有发生。

## 5. 推理、重试与流

**参与者 / 前提 / 结果：** 宿主持有此供应商认证，以完整历史调用模型；返回第一个成功组的响应流，或结构化路由错误。

| 阶段与边界 | 检查 / 拒绝 | 状态与副作用 |
| --- | --- | --- |
| 宿主 → Router | 精确 AIHub origin、无 query；只允许 GET `/v1/models` 或 POST 两个推理路径。body 有限且为 JSON、model 非空；拒绝 previous_response_id / conversation | 限额内缓冲原始 body，供首块前重试；读取受请求取消 / 总期限控制，取消 reader 后停止 |
| 同会话串行 → 候选选择 | 排除名单优先；允许名单、倍率、available、检测 / 模型限制、冷却均须满足；`requirePassed` 要求显式 true | 排队可取消；清理到期内存项；按策略排序，合格的亲和组优先；managed 池满只用已有组 |
| 准备 Key / 模型列表 | keyFor 失败立即停止路由；modelIds 失败冷却该组并换下个候选，取消则退出；列表无目标模型则跳过 | 这些准备过程不计入推理 maxAttempts；不发付费探测 |
| 服务端 → AIHub | Key / 模型检查通过 | 最多 maxAttempts 次推理。只转发 accept / openai-beta；Authorization 换为分组 Key，Cookie、宿主凭据、内部 session 头不传出 |
| AIHub 状态 / 首块前故障 | 401 / 403 / 429 / 5xx 或网络 / 首块超时可换组；普通 400 / 404 等立即返回错误，不换组 | 冷却至少 cooldownMs，尊重更长 Retry-After；清除旧亲和。首块前重试仍可能重复计费 |
| 首个响应块 → 宿主 | 一旦交出流，不再重放 | 更新延迟 / 亲和，清除总等待计时器；中断报错并冷却。调用方取消会中止上游 |

证据：[Router.fetch / boundedBody](../src/router.mjs)。亲和键包含路径 / 模型 / 会话值的哈希，只保存在本进程；重载丢失，不能恢复上游 response ID。没有跨进程锁或共享状态承诺。

相关验证状态见 [测试覆盖映射](tests.md)。
