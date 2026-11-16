# 配置与凭据

插件没有环境变量配置入口，也未声明外部依赖；配置由 Magpie 插件 options 和 auth API 提供。固定供应商 `aihub-auto`，固定 origin `https://aihub.top`，API base 为 `https://aihub.top/v1`。见 [配置源](../src/config.mjs)、[清单](../package.json)。

## 非敏感 options

全部由 [settings](../src/config.mjs) 在服务端校验，未知键拒绝；UI 仅保存识别的非敏感键。以下参数均为当前插件作用域，修改 / 恢复通过宿主设置页，可能重载插件。不是环境变量。

| Name | 默认值 / 合法范围 | used-by / 客户端或服务端 | 风险与变更意义 |
| --- | --- | --- | --- |
| maxMultiplier | 0.16；0–100 有限数 | UI + Router | 倍率筛选上限，0 仅免费组；名义阈值，不是金额预算 / 远端 Key 配额 |
| strategy | balanced；economy / balanced / speed | UI + Router | 分别按倍率、倍率×(1+min(ms,60000)/10000)、延迟排序；未知延迟取 30000ms |
| maxAttempts | 3；整数 1–5 | UI + Router | 推理发送次数含首次；Key / 模型读取不计入；首块前切换可能重复计费 |
| poolSize | 4；整数 1–8 | UI + Account / Router | managed 已保存 Key 数量上限；池满不自动换 Key / 删 Key；managed 发现不受是否已有 Key 限制；已有 Key 补充最多读取 N 个 |
| excludedGroups | []；正安全整数数组 | UI + Router | 排除优先 |
| allowedGroups | []；正安全整数数组 | UI + Router | 空数组不额外限组，仍受其他筛选 |
| requirePassed | false；boolean | UI + Router | 要求大厅检测 passed=true；manual 没有该证据，开启会排除全部手工组 |
| autoCreateKeys | false；boolean | UI + Account | 用户主动开启才可 POST 创建；关闭不撤销已建 Key |
| defaultApi | responses；responses / chat | UI + 入口 / 配置 | 选择宿主适配协议，不转换请求语义 |
| models | []；最多 200 项且 ID 唯一 | UI + 入口 / 配置 | 字符串或 `{id, api?, context?, output?}`；ID 1–160 个允许字符；api 同上；context / output 为正安全整数。显式配置优先；空列表 managed 从账号目录/大厅发现、manual 读取已有 Key；不证明远端推理可用 |
| refreshMs | 60000；整数 10000–3600000ms | 服务端，UI 保留 | 目录 / 模型缓存新鲜期；按使用惰性刷新，不是轮询任务 |
| maxStaleMs | 600000；整数 10000–3600000ms | 服务端，UI 保留 | 目录刷新失败可接受的快照年龄；取消等待时不回退；不保证状态仍有效 |
| firstByteTimeoutMs | 30000；整数 10–120000ms | 服务端，UI 保留 | 每次推理直到响应首块的等待；超时可换组 |
| totalTimeoutMs | 90000；整数 10–300000ms | 服务端，UI 保留 | 缓冲 / 排队 / 目录 / 首块前的总期限；body reader 与等待可取消；首块后清除，不限制完整流时长 |
| cooldownMs | 30000；整数 10–3600000ms | 服务端，UI 保留 | 失败组冷却下限；模型列表读取失败也会冷却；推理 Retry-After 可延长 |
| sessionTtlMs | 86400000；整数 1000–604800000ms | 服务端，UI 保留 | 内存亲和生存期；重载丢失 |
| maxSessions | 5000；整数 1–50000 | 服务端，UI 保留 | 内存亲和条目限制；超限移除最早插入项 |
| maxBodyBytes | 20971520；整数 1024–52428800 字节 | 服务端，UI 保留 | 首块前重试缓冲上限；请求历史保留在进程内存 |

UI 的模型编辑形式是 `modelID` 或 `modelID|api`；保存会保留同 ID 已有的合法 context / output。未指定的配置模型默认 context=128000、output=16384；动态发现模型也用这组占位值，其 cost=0 不构成免费声明。见 [模型配置](../src/config.mjs)、[动态发现](../index.mjs)、[UI 保留逻辑](../ui/app.js)。

## 认证包、敏感值与内存状态

来源均在宿主认证流程，保存位置是 Magpie auth API 的 `type: api`、`key: JSON.stringify(data)`，metadata 包含 identity 邮箱。不是普通 options，也不是本仓库中的凭据文件；宿主存储是否加密、备份是否带凭据均依赖宿主，未经验证。后续保存先比对当前 instanceId；宿主无 CAS，检查后重连仍有竞态。见 [auth 方法](../index.mjs)、[accountSaver](../src/account.mjs)。

| Name | used-by / scope / source | 轮换 / 清理 | 风险 |
| --- | --- | --- | --- |
| 登录 email / password | 服务端登录；用户在宿主认证表单提交 | 密码在 AIHub 修改；仅用于本次 POST，插件不保存密码 | 邮箱成为 identity；密码仍须经过宿主表单和 AIHub 传输路径 |
| version / mode / instanceId / identity | 服务端；授权生成 version=1、manual / managed、UUID、邮箱或导入标签；写 auth 包 | 重新授权生成新实例；核对旧专用 Key | instanceId 影响恢复名称与旧连接检查，不是权限 claim；identity 是个人信息 |
| access / refresh / expires | 服务端 managed；AIHub 登录 / refresh 返回；写 auth 包 | 管理 GET 遇 401 按需刷新；准备新组 Key 时有 refresh 且已知 expires 在 30 秒内则先刷新；失效重新登录 | 未知 expires 不预判；创建 POST 遇 401 保留 pending 并停止，不重试；无定时刷新 |
| keys[].key / groupId | 服务端；导入或专用 Key 创建 / 恢复；写 auth 包 | 在 AIHub 人工撤销并重新导入 / 授权；插件不自动删除 | Key 可发推理，可能计费；导入 Key `owned: false` |
| keys[].multiplier / models | 服务端 manual；用户导入声明 | 人工核对、重新导入 | 不读取账号倍率或检测监控；错误声明可能突破用户实际成本预期 |
| keys[].remoteId / name / owned | 服务端 managed；专用 Key 响应；写 auth 包 | 到 AIHub 人工核对 / 撤销 | 名称仅恢复当前实例 Key；不构成远端所有权证明 |
| pending.groupId / name / idempotencyKey | 服务端 managed；创建前生成并先写 auth 包 | 未知结果须核对 AIHub；恢复唯一精确 Key 后清除 | 未解决时阻止盲目重建；不保证 AIHub 已实现幂等语义 |
| dirty / saveRevision / saveQueue | 服务端内存；每次认证保存递增代次、串行持久化 | 保存成功仅清除同代 dirty；失败保留 dirty | 防止旧成功掩盖新失败；不提供宿主 CAS |
| snapshot / models / sessions / cooldown / latency / locks | 服务端进程内存；目录 / 模型读取、请求和响应更新 | 到期惰性清理或重载消失 | 无多进程共享保证；亲和丢失后可换组 |
| x-aihub-auto-session / prompt_cache_key | 宿主请求 → Router 会话哈希 | 随亲和 TTL / 重载清理 | 内部 session 头不传给 AIHub；请求 JSON 原样转发，prompt_cache_key 仍在 body 中 |
| `magpie-aihub-internal` | loader 返回宿主的固定占位 apiKey | 无需轮换 | 不是真实 Key；出站 Authorization 被真实分组 Key 替换 |

静态 [UI 代码](../ui/app.js) 和 [页面](../ui/index.html) 不包含真实密钥，不从 auth 包取密钥，也不提交登录凭据。UI bridge 可读取 options，因此不得将秘密写入 options。服务端拒绝未知 option 名称，并提示秘密应进入认证表单；这不等于宿主提供了加密保证。

## 上线前核对

- 在目标 Magpie 主机核实认证存储、备份与加密方式；本次未做真实主机 / 账号验证。
- 用自己的账号 / Key 核对 AIHub API 契约、权限、模型可用性和实际倍率；手工 multiplier 必须自行维护。
- 检查 `autoCreateKeys` 保持关闭，或明确接受其创建副作用；对 pending 先核对远端，不盲目重新授权以绕开未知结果。
- 需要金额限制时在 AIHub 核实并自行设置；本插件的倍率上限和池大小不能充当费用封顶。
- 确认完整历史请求、首块前重试可能重复计费、重载丢失亲和这些条件适合调用方。

相关：[架构](architecture.md)、[权限](permissions.md)、[自动化](automation.md)、[测试覆盖映射](tests.md)。
