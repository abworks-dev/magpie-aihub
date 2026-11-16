# 权限与副作用流程

v0.2.0 预发布版本的代码阅读映射。已有 local mock 和 Edge 合成桥接验证；未做真实生产 / 账号联调，六平台外部接口仅按公开代码核对，不能当作六平台实测。静态访问规则见 [权限](permissions.md)，参数见 [配置与凭据](variables.md)。

## 1. 保存路由选项

**参与者 / 前提 / 结果：** 能打开当前插件页面的宿主用户；Magpie bridge 就绪；非敏感 options 保存到当前插件。

| 顺序与边界 | 检查 / 拒绝 | 副作用 |
| --- | --- | --- |
| UI → bridge options.get | 无 bridge / 超时则禁用表单；只保留识别的非敏感键 | 读取当前选项，不读取 auth |
| 用户提交 → UI 校验 | 六平台列表、数字范围、分组正整数、模型命名空间 / 协议 / 重复检查；保存间隔至少 1100ms | 无效输入不发起写入 |
| UI 再读最新 options → options.set(next) | 保留有效高级选项与模型 context / output；桥接作用域由宿主执行 | 写当前插件 options，可能重载、清空内存亲和 |
| 等待保存结果 | 15 秒超时标为结果未知；重新打开核实，不自动重发 | 表单保留 |

证据：[UI 初始化 / 保存](../ui/app.js)、[服务端 settings](../src/config.mjs)。UI 校验不是服务端安全边界；加载选项时再次校验，没有应用角色判断。

## 2. 导入凭据或账号登录

**参与者 / 前提 / 结果：** 自有 AIHub 账号或分组 Key 的用户，在宿主认证表单操作；获得 aihub-auto 认证 JSON 包。

| 路径与边界 | 检查 / 拒绝 | 数据变化 / 远端调用 |
| --- | --- | --- |
| 宿主表单 → 手工导入 | 1–32 项；groupId 正整数且唯一；非空 key；非负有限 multiplier；platform 为支持的六平台之一，省略默认 openai；models 为原始 ID 字符串数组 | 新 instanceId、mode:manual、owned:false；不调用账号登录 API |
| 宿主表单 → 服务端 → AIHub | POST /api/v1/auth/login；拒绝重定向 / 错误 JSON / 非成功 code；2FA 或无 access_token 则失败 | 邮箱 / 密码与空 turnstile_token；保存 access / refresh / expires / identity，不保存密码 |
| 服务端 → Magpie auth API | authorize 仅返回成功包或 failed；Account 检查 version / mode / keys | 宿主保存 JSON key；UI 不接收凭据 |
| 已加载连接 fetch / 保存 → 当前认证 | 重新读取并比对 instanceId；断开或切换则拒绝旧连接请求 / 保存 | 保存串行排队，以代次保护 dirty；无 CAS，检查后重连仍可能竞态 |
| 管理 API 401 → 刷新 | 有 refresh，且 access 未被其他刷新替换时发起 / 合并刷新；等待可取消 | POST /api/v1/auth/refresh 后保存令牌；GET 可重试一次，有 body 的写操作不自动重放 |

证据：[auth / loader](../index.mjs)、[login / tokenFields](../src/api.mjs)、[Account.call / save / accountSaver](../src/account.mjs)。本地无角色 / claim 检查；AIHub 校验远端令牌权限，宿主控制认证表单与存储访问。

## 3. 发现模型与读取目录

**参与者 / 前提 / 结果：** 宿主模型发现、模型请求或监控 GET；有效认证；获得模型 ID / 库存 / 候选，不能据此认定推理已通过。

- provider.models 有显式 models 时直接使用配置，无认证不发现。managed 从可用分组与大厅广告模型发现，按启用平台、倍率、组范围、检测和模型限制筛选；缺大厅模型时可用有效的非空组模型限制列表。目录缺可识别模型证据且无已有 Key 补充时明确报错。manual 最多读取前 poolSize 个已有 Key，不为列表创建 Key。
- 对外 OpenAI ID 保持原值，其他平台使用 platform::model；与平台明确绑定。自动发现使用默认协议，不凭名称猜原生 Gemini；原生模型须显式配置 api:gemini。
- Key 自带 models 时直接使用；否则以分组 Bearer Key GET /v1/models，15 秒超时、拒绝重定向，要求 data 数组；按组内存缓存 refreshMs。此目录读取与推理认证头分别处理。
- 缓存过期后惰性读取。managed 并行 GET /api/v1/groups/available、/api/v1/groups/rates、/api/v2/public/providers；仅 public v2 返回 404 / 410 时回退 v1。
- 库存保留六平台分组及筛选原因；路由候选须 active、平台支持且启用、仍在大厅可见、无明确检测失败等。倍率优先账号 rates，再 group，再大厅。刷新失败仅在 maxStaleMs 内用旧快照；调用方取消等待时不回退。
- manual 以保存 Key 生成候选，不读取账号倍率或检测状态；requirePassed 开启时缺 passed 证据会全部排除。缺失监控指标为 null，不能推断为零或健康。

证据：[发现](../src/router.mjs)、[目录与模型](../src/account.mjs)、[目录解析](../src/api.mjs)、[waitFor](../src/async.mjs)、[平台](../src/platforms.mjs)。没有付费推理探测或后台目录轮询；监控快照读取可触发同一目录读取流程。

## 4. 准备专用 Key

**参与者 / 前提 / 结果：** 业务模型请求触发 managed Key 准备；已有 Key 可用，否则须可恢复或已开启 autoCreateKeys。监控不进入此流程。

1. Account 实例内串行处理 Key 变更；等待可取消，未开始的已取消操作不执行。已有本地组 Key 先处理未完成保存。
2. 无 Key 时检查 managed 模式、池大小和 pending；未解决 pending 属于其他组时拒绝新建。
3. 有 refresh 且已知 expires 距今不超过 30 秒，先刷新并保存；再分页 GET /api/v1/keys?page=…&page_size=100，最多 100 页。仅恢复 magpie-aihub-{instanceId 前12字符}-g{groupId} 精确名称、相同 group_id、active 的唯一 Key。重复则失败，其他 Key 不采用。
4. 有 pending 但未恢复 Key，报告未知结果并停止，不自动重建；无 pending 且 autoCreateKeys 关闭时拒绝创建。
5. 生成 UUID 幂等键，先将 pending 写入 auth；保存成功后才单次 POST /api/v1/keys，body 仅 name / group_id，附 Idempotency-Key。未知到期情况下创建收到 401 仍保留 pending 并停止，不刷新后重试。
6. 校验返回 key / id / group_id / 名称，必要时重新列表恢复；完整结果加入带平台信息的 owned Key、清除 pending，再保存；失败保留可核实状态。

Key 准备失败立即停止当前路由，返回 error.type=aihub_routing_error 及稳定 code / 安全 message：key_not_imported、key_pool_full、key_creation_pending、key_duplicate、key_creation_disabled、key_creation_incomplete；管理状态 401 / 403 / 429 映射 key_sign_in_required / key_access_denied / key_rate_limited，其余 key_preparation_failed。不返回原始管理响应，不通过换组或盲目重建掩盖未知结果。

证据：[keyFor](../src/account.mjs)、[错误](../src/errors.mjs)、[路由错误](../src/router.mjs)。无 DELETE / PUT、无远端 Key 配额设置；关闭自动创建不撤销 Key。取消等待不能证明已发出的远端创建未发生。

## 5. 推理、重试与流

**参与者 / 前提 / 结果：** 宿主持有认证，以完整历史调用模型；返回首个成功组的响应流，或结构化路由错误。

| 阶段与边界 | 检查 / 拒绝 | 状态与副作用 |
| --- | --- | --- |
| 宿主 → Router | 固定 AIHub origin；GET /v1/models，POST /v1/responses、/v1/chat/completions，或原生 Gemini /v1beta/models/{model}:generateContent / :streamGenerateContent；仅原生流式可选 alt=sse，其他 query 拒绝 | body 限额 JSON，取消/总期限控制；拒绝 previous_response_id / conversation，限额内缓冲供首块前重试 |
| 平台 / 协议解析 | 非 OpenAI platform::model 与内部平台头须匹配；Gemini responses / gemini，其余 responses / chat；已启用平台 | 上游前剥离命名空间，保持原始模型；无跨平台 / 换模型 failover |
| 同会话串行 → 候选 | 排除优先，允许名单 / 倍率 / available / 检测 / 模型限制 / 冷却均满足；requirePassed 要求显式 true | 等待可取消；清到期项，合格亲和优先；managed 池满只用已有组 |
| 准备 Key / 模型 | keyFor 失败立即停止；modelIds 失败冷却并换候选，取消退出；缺目标模型则跳过 | 不计入推理 maxAttempts，不发付费探测 |
| 服务端 → AIHub | Key / 模型检查通过 | 最多 maxAttempts 次；只转发 accept / openai-beta，注入分组 Bearer 或原生 x-goog-api-key；不传 Cookie、宿主凭据、内部平台/会话头 |
| 状态 / 首块前故障 | 401 / 403 / 429 / 5xx、网络 / 首块超时可在同平台同模型间换组；普通 400 / 404 等立即返回 | 冷却至少 cooldownMs，尊重更长 Retry-After；清旧亲和；首块前重试仍可能重复计费 |
| 首块 → 宿主 | 一旦交出流不重放 | 更新延迟/亲和，清总等待计时器；流中断报错并冷却，取消中止上游 |

证据：[Router.fetch / boundedBody](../src/router.mjs)。亲和哈希包含路径 / 平台 / 模型 / 会话值，限本进程；重载丢失，不能恢复上游 response ID，没有跨进程锁或共享状态承诺。

## 6. 可选只读监控

monitorEnabled 默认 false，monitorPort=19871 仅为默认候选，尚未生产分配。静态设置页 → bridge.service 导航 → 可选 page.service loopback 页面 → GET /snapshot；要求精确 Host、受限 Origin / 方法与随机内存 token。Cloud 仅批准四个静态资源，未批准 service 新路由；opc-agent 生产私有路径拒绝不可绕过。

快照读取最多 32 个内存运行时，读取目录可触发远端 GET、令牌刷新与保存；不调用 keyFor 或任何推理。返回白名单分组状态/筛选原因、指标、目录新鲜度、Key 计数与最近 100 条路由，缺失指标 null；不返回认证、Key、Cookie、body 或原始 session。进程退出即失去记录，不是持久审计。

证据：[快照](../src/telemetry.mjs)、[服务](../src/monitor.mjs)、[入口](../index.mjs)、[页面](../ui/app.js)。相关验证状态见 [测试覆盖映射](tests.md)。
