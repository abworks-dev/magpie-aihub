# 自动化边界

这里的自动化是确定性 Key 准备、六平台同平台同模型路由与只读页面监控，没有嵌入式代理、提示词驱动工具调用、邮件或定时作业。目录 / 模型缓存按使用惰性刷新，没有付费探测。v0.3.1 为预发布版本；已做 local mock、官方宿主隔离与 Edge 合成代理验证，真实生产 / AIHub 账号联调未验证，公开平台代码核对不代表六平台实测。代码证据：[Account](../src/account.mjs)、[Router](../src/router.mjs)、[快照](../src/telemetry.mjs)、[页面服务](../src/service.mjs)。

## 触发、所有者与输出

| 路径 | 触发 / 所有者 / 授权 | 读取与输出契约 | 失败处理 |
| --- | --- | --- | --- |
| 账号令牌刷新 | managed 管理调用收到 401，或准备新组 Key 时已知 expires 在 30 秒内且有 refresh；当前账号；不是定时刷新 | 读取 refresh，要求非空 access_token；更新 access / refresh / expires 并保存 auth 包 | 合并 401 刷新；等待可取消；GET 可再调一次；写入不重放；保存失败则失败 |
| 目录刷新 | 模型请求取候选或监控 GET，快照超过 refreshMs；当前实例 | 读取账号 groups / rates / 大厅；识别六平台，路由仅采用合格候选，监控保留排除原因 | 合并并发刷新；未取消且旧快照年龄不超过 maxStaleMs 才可兜底 |
| 模型发现 / 读取 | 宿主发现或路由准备；managed 读取账号分组与大厅，manual / 补充来源仅当前实例已有 Key | 大厅广告模型、有效分组模型列表或已有 Key 的 `data[].id`；按候选政策筛选，发现输出去重排序 ID | 不创建 Key；发现失败报错；路由中 modelIds 失败冷却该组并继续下个候选，取消则退出；结果不保证推理可用 |
| 专用 Key 恢复 / 创建 | managed 模型请求缺组 Key；账号属于用户。新建默认禁用，须预先开启 autoCreateKeys | 读取 keys / pending 和账号 Key 列表；仅接受精确实例名称、相同组、完整有效 Key | 先持久化 pending，单次 POST；未知结果含 401 不重建；重复恢复结果拒绝；keyFor 失败停止路由 |
| 请求路由 / 换组 | 宿主调用本供应商；fetch 前比对当前认证 instanceId | 读取 body、组目录、模型列表和内存状态；输出上游 Response 流，或 `{error:{type:'aihub_routing_error',code,message}}` | 限推理 maxAttempts；首块前有限重试，首块后不重放；body 读取 / 等待 / 上游请求可取消 |

## 可调用的精确远端 API

服务端固定 `https://aihub.top`，拒绝重定向。管理 API 通用适配器仅使用 GET / POST；以下是当前实际调用面。

| 方法 / 路径 | 凭据与条件 | 副作用 |
| --- | --- | --- |
| POST `/api/v1/auth/login` | 用户本次邮箱 / 密码，turnstile_token 为空 | 获得账号令牌；2FA 不支持，转用手工 Key |
| POST `/api/v1/auth/refresh` | refresh_token | 刷新账号令牌并写 Magpie auth |
| GET `/api/v1/groups/available` | 账号 access Bearer | 读取组目录 |
| GET `/api/v1/groups/rates` | 账号 access Bearer | 读取账号倍率 |
| GET `/api/v2/public/providers` | 经 Account.call，可能携带账号 access | 读取大厅；仅 404 / 410 回退 GET `/api/v1/public/providers` |
| GET `/api/v1/keys?page=N&page_size=100` | 账号 access；N=1…100 | 列表用于恢复唯一专用 Key，不采用无关 Key |
| POST `/api/v1/keys` | 账号 access；启用 autoCreateKeys、池未满、无未解决冲突 | body 仅 name / group_id，Idempotency-Key 已先写 pending；创建远端 Key，无金额配额字段 |
| GET `/v1/models` | 分组 Key Bearer | 只读模型 ID；不会推理探测 |
| POST `/v1/responses` | 分组 Key Bearer，路由筛选通过 | 发送用户完整请求，可能计费 |
| POST `/v1/chat/completions` | 同上，非 Gemini 平台 | 同上 |
| POST `/v1beta/models/<model>:generateContent` / `:streamGenerateContent` | 原生 Gemini，分组 `x-goog-api-key`；流式仅允许可选 `alt=sse` | 发送业务请求，可能计费 |

证据：[API](../src/api.mjs)、[管理调用 / Key 创建](../src/account.mjs)、[路由请求](../src/router.mjs)。没有 DELETE / PUT、外部 Webhook、任意工具执行或付费健康探测入口。

## 策略与硬限制

用户 steering 仅来自 options，没有代理提示词。可信服务端钩子本身运行在 Magpie / Bun 进程，未沙箱化；以下是插件代码约束，不是宿主进程的通用隔离。

- **创建授权：** autoCreateKeys 默认 false；每个候选组检查 poolSize。名称固定 `magpie-aihub-{instanceId 前12字符}-g{groupId}`；已知令牌临近到期先刷新，创建前先保存 pending。只恢复精确名称 / 组 / active 的唯一 Key。无关 Key 不接管、不删除、不改写。未知到期情况下创建 POST 遇 401 也保留 pending、停止且不重试。见 [keyFor](../src/account.mjs)。
- **保存边界：** 串行保存用代次标记，旧成功不能清除新失败的 dirty；每次保存比对当前 auth instanceId，旧账号 / 断开则拒绝。宿主没有 CAS，检查与写入之间重连仍有残余竞态。见 [save / accountSaver](../src/account.mjs)、[loader](../index.mjs)。
- **选择：** 排除优先，允许名单、maxMultiplier、available、检测、模型限制、冷却均需通过。0 倍率上限只选 0 倍率组；manual 倍率仅用户声明，没有账号检测监控，requirePassed 开启后无候选。见 [eligible / score](../src/router.mjs)。
- **平台 / 传输：** 非 OpenAI 模型使用 `platform::model`；仅同平台同模型候选间重试。Gemini 允许 responses / gemini，其他平台 responses / chat。Router 只接受固定 origin 和精确 GET / POST 路径，除原生 Gemini 流式可选 `alt=sse` 外拒绝 query；body 限额且读取受取消信号控制；拒绝 previous_response_id / conversation，要求完整历史。发出前剥离内部命名空间，出站头仅 content-type、分组 Authorization 或 x-goog-api-key、accept / openai-beta；不转发内部平台/会话头。见 [平台](../src/platforms.mjs)、[boundedBody / fetch](../src/router.mjs)。
- **重试：** maxAttempts 默认 3、上限 5，仅计推理发送；keyFor 失败停止，modelIds 失败冷却并继续。推理 401 / 403 / 429 / 5xx、网络与首块超时可切换，普通调用错误不切换。首块前重试可能重复计费，首块之后永不重放。冷却尊重更长 Retry-After。见 [重试与流](../src/router.mjs)。
- **时限 / 状态：** 管理与模型读取 15 秒；推理有每次首块期限和首块前总期限。等待刷新 / 队列可取消，未开始的已取消变更不会执行；已发远端副作用无法据此撤销。锁 / 亲和 / 冷却 / 延迟仅在一个进程内，没有跨进程保证。见 [API](../src/api.mjs)、[Account](../src/account.mjs)、[Router](../src/router.mjs)、[waitFor](../src/async.mjs)。

## 运维控制

| 控制 | 当前实现与边界 |
| --- | --- |
| 人工批准点 | 宿主认证表单；options 中主动启用 autoCreateKeys。不是每次创建弹窗；之后请求可自动触发创建 |
| 停止新建 | 保存 autoCreateKeys=false；不会撤销已有 Key。关闭供应商 / 插件或在 AIHub 撤销凭据由用户通过宿主 / AIHub 操作 |
| 终止当前请求 | 调用方 AbortSignal / 取消响应流；body reader 与等待响应取消；已发请求是否计费由远端决定 |
| 限流 / 数量 | maxAttempts、poolSize、maxBodyBytes、maxSessions、实例数量上限 32；清单 maxConcurrency=8 依赖宿主执行，不是金额或全局 RPS 限制 |
| 持久状态 | Magpie auth JSON 保存 tokens / keys / pending；不保存请求历史、目录快照或亲和 |
| 审计 / 时间线 | 监控仅显示最近 100 条进程内路由记录，不是持久审计日志；pending 和远端 Key 名称可人工核对，不能替代完整创建审计 |
| 未知创建结果 | 保留 pending，先在 AIHub 核查；未恢复到完整精确 Key 时不自动再次创建，不自动 DELETE 清理 |

## 页面服务与 Key 错误

设置与监控是同一份页面，由 page.service 在 127.0.0.1 提供；`monitorPort=19871` 是未生产分配的默认候选。`magpie web` 把服务代理到插件页面路径下，桌面版不代理、页面提示在本机打开回环地址。服务仅接受 GET/HEAD，要求精确 Host、Origin 缺省或 `null`、无 body；`/snapshot` 另需服务注入页面的进程级 token，响应 `Access-Control-Allow-Origin: null`。监控可读取远端目录，并可能刷新/保存管理令牌，不推理探测、不创建 Key。快照字段白名单与脱敏后才返回；缺失或未就绪指标 null。Cloud 仅批准四个静态资源，未批准 service 新路由，opc-agent 生产私有路径拒绝不能绕过。

Key 准备错误使用稳定 code：`key_not_imported`、`key_pool_full`、`key_cap_reached`、`balance_too_low`、`key_creation_pending`、`key_duplicate`、`key_creation_disabled`、`key_creation_incomplete`；管理状态映射为 `key_sign_in_required` / `key_session_expired` / `key_access_denied` / `key_rate_limited`，其余为 `key_preparation_failed`。这些失败停止当前请求，不公开原始响应，不通过换组或盲目重建掩盖未知创建结果。见 [错误](../src/errors.mjs)、[Key 准备](../src/account.mjs)、[页面服务](../src/service.mjs)。

余额读取走 `/api/v1/auth/me`、`/api/v1/usage/stats`、`/api/v1/user/platform-quotas`，默认 60 秒缓存；读取失败显示 `billing_unavailable` 并在 10 分钟内沿用旧快照。余额仅在读取到数值时参与 `minBalance` 门限，不参与路由排序，也不读会返回明文 Key 的 `/api/v1/keys`。见 [余额](../src/billing.mjs)。

相关：[流程](flows.md)、[权限](permissions.md)、[配置与凭据](variables.md)、[测试覆盖映射](tests.md)。
