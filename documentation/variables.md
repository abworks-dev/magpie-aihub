# 配置与凭据

插件无环境变量配置入口，无外部依赖；由 Magpie options 和 auth API 配置。固定供应商 aihub-auto、origin https://aihub.top；Responses / Chat / models base 为 /v1，原生 Gemini 为 /v1beta。见 [配置](../src/config.mjs)、[平台](../src/platforms.mjs)、[清单](../package.json)。v0.3.1 为预发布版本，真实生产联调未验证；六平台接口仅按公开代码核对，现有验证为 local mock 与 Edge 合成代理。

## 非敏感 options

全部由 [settings](../src/config.mjs) 服务端校验，未知键拒绝；[UI](../ui/app.js) 仅保存识别的非敏感键。参数作用于当前插件，经宿主设置页修改 / 恢复，可能重载插件；不是环境变量。

| Name | 默认值 / 合法范围 | used-by / 作用域 | 风险与变更意义 |
| --- | --- | --- | --- |
| platforms | [openai,deepseek,zhipu,kimi,grok,gemini]；支持平台的非空、无重复数组 | UI + 入口 / Router | 限制启用平台；同平台同模型 failover，不跨平台 |
| maxMultiplier | 0.16；0–100 有限数 | UI + Router | 名义倍率上限，0 仅免费组；不是金额预算 / Key 配额 |
| platformCaps | {}；平台→上限映射 | UI + Router | 每个平台自己的倍率上限，未列出的平台用 maxMultiplier；键只接受 openai/deepseek/zhipu/kimi/grok/gemini |
| strategy | balanced；economy / balanced / speed / price / value / reliable | UI + Router | 按倍率、倍率×(1+min(ms,60000)/10000)、延迟、真实价格排序；`value` = 价格×(1+min(ms,60000)/10000)×(1+3×(1-成功率))；`reliable` = (1-成功率)×1e6+价格；未知延迟取 30000ms |
| maxAttempts | 3；整数 1–5 | UI + Router | 推理发送次数含首次；Key / 模型读取不计入；首块前切换可能重复计费 |
| poolSize | 4；整数 1–32 | UI + Router | 一次路由最多依次尝试的候选分组数；不限制 Key 总数，池满不换/删 Key |
| excludedGroups | []；正安全整数数组 | UI + Router | 排除优先 |
| allowedGroups | []；正安全整数数组 | UI + Router | 空数组不额外限组，仍受其他筛选 |
| requirePassed | false；boolean | UI + Router | 要求大厅 passed=true；manual 缺该证据，开启会排除全部手工组 |
| autoCreateKeys | false；boolean | UI + Account | 主动开启才可 POST 创建；关闭不撤销已有 Key |
| maxKeysPerAccount | 8；整数 1–32 | UI + Account | 插件专用 Key 总数上限（唯一闸门）；达到后 `key_cap_reached`，不删除已有 Key |
| keysPerPlatform | 0；整数 0–32 | UI + Router | 每平台专用 Key 配额，0 表示不限；只限制新建，已有 Key 的分组不受影响 |
| minBalance | 0；0–100000 有限数 | UI + Account | >0 时余额低于阈值暂停新建 Key（`balance_too_low`）；读取失败不推断余额、不阻塞已有 Key |
| dailyBudget | 0；0–1000000 有限数 | UI + Router | 每日花费上限，按响应 usage 与分组真实价格累计；0 关闭；超限返回 429 `daily_budget_exceeded` |
| priceAlertRatio | 0.2；0.01–10 有限数 | UI + Router | 真实价格相对上次观测的变化比例阈值，超出则记入监控「价格波动」；只提示，不参与路由 |
| breakerWindowMs / breakerMinSamples / breakerFailureRate | 300000 / 5 / 0.5 | Router | 滑动窗口熔断参数：窗口内失败数 ≥ 样本下限且失败率 > 阈值才冷却分组 |
| defaultApi | responses；responses / chat | UI + 入口 | 宿主默认适配协议，不转换请求语义；Gemini 不支持 chat，原生须逐模型选择 |
| models | []；最多 200 项且公共 ID 唯一 | UI + 入口 | 字符串或 {id,platform?,api?,context?,output?}；原始 ID 1–160 个允许字符；非 OpenAI namespace 或显式 platform，二者须一致；api 为 responses / chat / gemini，Gemini 仅 responses / gemini，其余 responses / chat；context / output 正安全整数。显式配置优先，空列表发现，不证明推理可用 |
| monitorPort | 19871；整数 1024–65535 | UI + 入口 / page.service | 页面服务与只读监控的回环端口；仅默认候选，尚未生产分配或确认可用；需核对宿主端口与服务桥接 |
| refreshMs | 60000；整数 10000–3600000ms | 服务端，UI 保留 | 目录 / 模型缓存新鲜期，惰性刷新，不是轮询 |
| maxStaleMs | 600000；整数 10000–3600000ms | 服务端，UI 保留 | 刷新失败可用快照年龄，取消不回退，不保证状态有效 |
| firstByteTimeoutMs | 30000；整数 10–120000ms | 服务端，UI 保留 | 单次推理首块等待，超时可同平台同模型换组 |
| totalTimeoutMs | 90000；整数 10–300000ms | 服务端，UI 保留 | 缓冲/排队/目录/首块前总期限；可取消，首块后清除，不限完整流时长 |
| cooldownMs | 30000；整数 10–3600000ms | 服务端，UI 保留 | 失败组冷却下限，模型列表失败也冷却，Retry-After 可延长 |
| sessionTtlMs | 86400000；整数 1000–604800000ms | 服务端，UI 保留 | 内存亲和 TTL，重载丢失 |
| maxSessions | 5000；整数 1–50000 | 服务端，UI 保留 | 亲和条目上限，移除最早插入项 |
| maxBodyBytes | 20971520；整数 1024–52428800 字节 | 服务端，UI 保留 | 首块前重试缓冲上限，请求历史留在进程内存 |

模型编辑形式为 modelID 或 modelID|api，例如 deepseek::MODEL_ID|chat、gemini::MODEL_ID|gemini。OpenAI ID 保持原值；非 OpenAI 对外用 platform::model，上游前剥离命名空间。保存保留同 ID 已有合法 context / output；默认 context=128000、output=16384，动态模型也用这组占位值，cost=0 不构成免费声明。见 [模型](../src/config.mjs)、[发现](../index.mjs)、[UI](../ui/app.js)。

## 认证包、敏感值与内存状态

凭据来自宿主认证流程，保存到 auth API 的 type:api、key:JSON.stringify(data)，metadata 包含 identity 邮箱。不是普通 options / 仓库凭据文件；底层加密、备份取决于宿主，未经验证。保存前比对 instanceId；宿主无 CAS，检查后重连仍有竞态。见 [auth](../index.mjs)、[accountSaver](../src/account.mjs)。

| Name | used-by / scope / source | 轮换 / 清理 | 风险 |
| --- | --- | --- | --- |
| 登录 email / password | 服务端；宿主认证表单提交 | 密码在 AIHub 修改，仅本次 POST，插件不保存 | 邮箱成为 identity；经过宿主表单和 AIHub 传输 |
| version / mode / instanceId / identity | 授权生成 version=1、manual / managed、UUID、邮箱或导入标签；auth 包 | 重新授权新实例，核对旧专用 Key | instanceId 用于恢复名与旧连接检查，不是权限 claim；identity 为个人信息 |
| access / refresh / expires | managed；登录 / refresh 返回，写 auth | GET 401 按需刷新；准备新组 Key，有 refresh 且已知 expires 在 30 秒内先刷新 | 未知 expires 不预判；创建 POST 401 保留 pending 停止；无定时刷新 |
| keys[].key / groupId / platform | 导入或专用 Key 创建/恢复，写 auth | AIHub 人工撤销，再导入/授权 | Key 可计费；导入 owned:false；缺 platform 兼容旧包为 openai，平台需与组一致 |
| keys[].multiplier / models | manual 用户声明 | 人工核对、重新导入；models 为原始上游 ID | 不读取账号倍率或检测状态；错误声明影响成本预期 |
| keys[].remoteId / name / owned | managed 专用 Key 响应，写 auth | AIHub 人工核对/撤销 | 名称只恢复当前实例，不构成远端所有权证明 |
| pending.groupId / platform / name / idempotencyKey | managed 创建前生成，先写 auth | 核对未知结果，恢复唯一精确 Key 后清除 | 阻止盲目重建，不保证远端实现幂等 |
| dirty / saveRevision / saveQueue | 内存，认证每次保存递增并串行 | 成功仅清同代 dirty，失败保留 | 防旧成功掩盖新失败，无宿主 CAS |
| snapshot / models / sessions / cooldown / latency / locks / lastRoutes | 内存；目录、请求与响应更新 | 惰性清理 / 重载消失；最近路由上限 100 条 | 无跨进程共享，不是持久审计；亲和丢失后可换组 |
| x-aihub-auto-session / prompt_cache_key | 宿主请求 → 会话哈希 | 亲和 TTL / 重载清理 | session 头不外传；prompt_cache_key 仍在 body |
| x-aihub-auto-platform | 插件模型配置 → Router | 请求级 | 平台须与 namespace / 协议匹配，内部头不外传 |
| magpie-aihub-internal | loader 的固定占位 apiKey | 无需轮换 | 不是真 Key，出站改用分组 Bearer / 原生 Gemini x-goog-api-key |
| 页面服务 VIEW_TOKEN | 随进程随机生成，经服务注入页面 meta，仅用于同源快照读取 | 重载重新生成，不写 options/auth | 不是 AIHub Key；不作为公网身份认证保证 |

静态 [UI](../ui/app.js) 和 [页面](../ui/index.html) 无真实密钥，不读取 auth 或提交登录凭据；bridge 能读 options，不能把秘密放入 options。服务端拒绝未知名称并提示认证表单，不等于宿主有加密保证。

监控快照只输出脱敏白名单字段；成功率/TPS/缓存/价格等缺失、未就绪指标 null，不用 0 冒充。目录错误为安全 code，不泄漏原始管理错误；Key 错误使用稳定 code，详见 [错误处理](automation.md#页面服务与-key-错误)。见 [快照](../src/telemetry.mjs)、[页面服务](../src/service.mjs)、[Key 错误](../src/errors.mjs)。

## 上线前核对

- 在目标 Magpie 主机核实认证存储、备份与加密；真实主机 / 账号联调尚未验证。
- 以自己的账号核对六平台实际 API、协议、模型、权限与倍率；公开代码核对不等于真实调用，手工 multiplier 自行维护。
- autoCreateKeys 保持关闭，或明确接受创建副作用；pending 先核对远端，不重新授权来掩盖未知结果。
- 金额限制须在 AIHub 核实设置；倍率与池大小不是费用封顶，首块前重试可能重复计费。
- 页面服务与监控随插件启动，19871 未生产分配。Cloud 仅批准四个静态资源，无 service 新路由授权；opc-agent 生产私有路径拒绝不可绕过。
- 调用方发送完整历史，并接受重载丢失亲和；local mock / Edge 合成代理只证明对应本地路径。

相关：[架构](architecture.md)、[权限](permissions.md)、[自动化](automation.md)、[测试覆盖映射](tests.md)。
