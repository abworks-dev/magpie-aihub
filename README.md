# Magpie AIHub 自动路由

面向 **aihub.top 普通消费者** 的 Magpie Provider 插件。用自己的账户或分组 Key，在 Magpie 中提供一个 `aihub-auto` 上游入口，按倍率和延迟选组、保留会话线路、在首次响应前有限重试。

**状态：0.1.3 开发预览，仓库公开。** 独立实现，没有复制 aihub-auto 源码。已用官方 Magpie 0.1.3250 隔离验证插件加载、合成凭据登录与两种模型 SDK 注册；0.1.2 修复沙箱中点击保存无反应，0.1.3 修复新账户没有专用 Key 时的自动模型发现，并使用 AIHub 官方站点图标。真实 AIHub 账户与推理尚未由开发者联调。当前支持 AIHub **OpenAI 平台分组** 的 Responses / Chat Completions，不宣称原生 Claude/Gemini 全平台支持。

图标取自 [AIHub 官方站点](https://aihub.top/) 公开页面的 PNG favicon，并内嵌到插件元数据和设置页；不额外请求图标地址或新增代理资源路径。品牌图像权利归原站点。

## 安装

在 Magpie 插件页从 Git 安装：

```text
github:abworks-dev/magpie-aihub#v0.1.3
```

公开仓库无需 GitHub 私有仓库权限；运行 Magpie 的主机仍需能够访问 GitHub。也可将完整仓库放到 Magpie 容器/主机可读路径，使用本地插件安装方式。无需编译，不启动额外监听端口，不依赖独立代理服务。建议固定版本或 commit。详细步骤及失败时需要的脱敏信息见[安装与首次验收](documentation/installation.md)。

本项目使用 [Magpie 插件接口](https://usemagpie.ai/docs/zh/plugins) 的密码提示、keyless API authorize、provider.models 和插件页面桥接。固定版本的真实宿主检查与尚未验证项见[验证记录](documentation/tests.md)；安装到你的实例后仍需核对页面、认证和模型列表。

## 两种接入方式

### 1. 手工导入分组 Key（推荐首次验收）

在 `AIHub Auto` 的连接/认证界面选择“导入分组 Key”，在**保密输入框**填写 JSON 数组。例如以下全是假值：

```json
[
  {"groupId": 101, "key": "REPLACE_WITH_GROUP_101_KEY", "multiplier": 0.08, "models": ["YOUR_MODEL_ID"]},
  {"groupId": 202, "key": "REPLACE_WITH_GROUP_202_KEY", "multiplier": 0.12, "models": ["YOUR_MODEL_ID"]}
]
```

- 每把 Key 应绑定一个固定的 OpenAI 分组，`multiplier` 填你的实际账号倍率。
- `models` 可省略，此时通过该 Key 的 `/v1/models` 获取；提供时按你声明的精确模型 ID 匹配。
- 此模式不登录控制台、不创建/删除/修改远程 Key，也不读取账号大厅；按声明倍率、实际首字节延迟和错误结果路由。
- `requirePassed` 必须关闭：手工模式没有可信的大厅检测结果。如果 AIHub 改价，需更新导入信息；这不是动态费用上限。

### 2. AIHub 账户模式

在认证界面输入 AIHub 邮箱和密码。密码仅用于登录，保存访问/刷新令牌；需要 2FA 或交互验证码时登录可能失败，可改用手工 Key。

登录后，模型列表留空即可从账号可用分组与供应商大厅发现模型，不需要先创建专用 Key。发现结果受实际倍率、允许/排除分组、检测状态及组内模型限制筛选；目录未提供可识别模型时会提示错误，可手工指定准确 ID。显式配置模型优先于自动发现。

**获取模型与调用模型是两步。** 自动发现只读取目录，不调用推理、不创建 Key。若账户尚无本插件专用 Key，首次业务请求前仍需主动开启 `autoCreateKeys`，或改用手工导入分组 Key。自动发现的模型使用“默认 API”，不会凭模型名称猜协议。

此模式会：

1. 读取账号可用分组、专属倍率以及供应商大厅；优先使用 v2 大厅接口。
2. 排除非 OpenAI 分组、下架/明确检测失败分组、超倍率及人工排除分组。
3. 为选中的分组创建 `magpie-aihub-<instance>-g<id>` 专用 Key，上限由 `poolSize` 控制。
4. 保存归属与未完成创建记录；未知创建结果只重新查询，不盲目重建。

**不会自动删除 Key，不会改绑现有 Key，也不会自动清理其他实例的 Key。** 没有验证 AIHub 建 Key 的额度参数，因此不会声称新 Key 自带消费限额。可在 AIHub 控制台为专用 Key 设置额度，关闭它的自动改组，并避免其他选组工具管理同一把 Key。

池满后继续用已建 Key；价格排名变化不会自动轮换/删除。若某次创建结果不确定，先查看 AIHub 中对应专用名称；自动恢复只接受精确匹配项。删除插件或重新登录不会撤销旧的远程 Key，请在 AIHub 手工核对、撤销不再使用的专用 Key。

## 常用设置

插件自带中文配置页，仅保存非秘密选项。账号密码、令牌和 Key 均不应放进 options。

| 选项 | 默认 | 含义 |
|---|---:|---|
| `strategy` | `balanced` | `economy` 按名义倍率；`speed` 按首字节延迟；`balanced` 将倍率与延迟相乘评分 |
| `maxMultiplier` | `0.16` | 名义倍率硬上限，**0 表示只允许免费组** |
| `maxAttempts` | `3` | 每次请求最多推理尝试数，包含首次；范围 1–5 |
| `poolSize` | `4` | 托管专用 Key 数量上限，范围 1–8；手工导入可多于此值 |
| `allowedGroups` / `excludedGroups` | `[]` | 分组 ID 白名单/排除名单，排除优先 |
| `requirePassed` | `false` | 仅使用大厅 `passed` 分组；手工模式不支持 |
| `autoCreateKeys` | `false` | 允许账户模式按需创建 Key；关闭不撤销已有 Key |
| `defaultApi` | `responses` | 默认模型协议，另一个值为 `chat` |
| `models` | `[]` | 字符串 ID，或 `{id, api, context, output}`；空列表：账户模式从分组/大厅发现，手工模式读取已有 Key |
| `firstByteTimeoutMs` | `30000` | 单次等待响应头和首字节的期限 |
| `totalTimeoutMs` | `90000` | 路由与首字节总预算，成功输出后不截断长流 |
| `refreshMs` / `maxStaleMs` | `60000` / `600000` | 请求触发的目录刷新间隔 / 故障时旧目录可用上限 |
| `sessionTtlMs` | `86400000` | 内存会话保留时间 |

只有精确匹配的模型 ID 才参与路由，不自动改模型名。发现模型时上下文/输出默认 128000/16384，真实能力可能不同；可显式配置。发现模型成本字段为未知占位 0，不表示免费；实际计费以 AIHub 为准。

## 路由边界

- Magpie 会话 ID → 插件内部会话映射；没有会话标识时每次独立选组。内部会话头不会发给 AIHub。
- 同一会话在分组仍符合硬条件时优先保留原组。亲和状态仅在内存，宿主重载/重启会重置；不保证模型提供方一定命中缓存。
- 限流、401/403、5xx、网络错误与首字节超时触发冷却和候选切换；遵守 `Retry-After`。普通 400/404 不泛化重试。
- 已返回首字节后，流中断直接报错，不重放请求。首次响应前重试仍可能导致上游重复计费；与 Magpie 外层重试共同控制总预算。
- 客户端需发送完整对话历史。`previous_response_id` 和服务端 `conversation` 状态续接会明确拒绝，避免把上游状态错误路由到另一组。
- 仅接收固定 `https://aihub.top/v1` 下的 Responses、Chat Completions 和 models；禁止重定向，不支持自定义上游 URL。
- 仅通过明确的请求头白名单转发；不转发客户端 Cookie、Magpie API Key 或管理令牌。
- 没有后台付费探测、遥测、自动计划任务或额外 HTTP 服务。目录按业务请求刷新。

## 开发与验证

```sh
npm test
npm run check
npm pack --dry-run
```

源码为无依赖 ESM，测试使用 Node >=22 内置测试器；运行环境为 Magpie 的 Bun 插件宿主。CI 同时检查 Node 与 Bun。没有下载后自动执行的安装脚本。

验收顺序：先导入两把已限额的测试 Key → 核对模型列表和协议 → 少量真实对话 → 检查会话保持和失败场景 → 再考虑账户自动建 Key。真实模型测试会产生费用；单元测试使用模拟 fetch，官方宿主检查仅使用不会发起推理的合成 Key。

[架构与边界](documentation/architecture.md) · [认证/请求流程](documentation/flows.md) · [权限](documentation/permissions.md) · [配置与秘密](documentation/variables.md) · [自动化](documentation/automation.md) · [验证记录](documentation/tests.md)

## 来源与许可

本项目 MIT。根据公开接口文档与消费者 API 契约独立实现；未复制 `WSXYT/aihub-auto` 或未确认许可项目的实现。

参考：[Magpie 插件接口](https://usemagpie.ai/docs/zh/plugins)、[llm-retry-proxy 的 MIT 适配器与夹具](https://github.com/momijineko/llm-retry-proxy/tree/5ee295abba330078adee3a5e065459df36a38a11/retry_proxy/sync_adapters)。公开消费者的字段观测不等于 AIHub 官方稳定契约；接口变化会导致适配失败。
