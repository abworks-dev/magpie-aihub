# 安装与首次验收

## 安装固定版本

**v0.2.0 为预发布版本。** 在已登录的 Magpie 插件管理页添加以下固定 Git 来源：

```text
github:abworks-dev/magpie-aihub#v0.2.0
```

仓库公开，不需向插件提供 GitHub Token。服务器必须能访问 GitHub 及 Magpie 插件运行时。推理路由无需编译或新增代理监听；可选监控默认关闭。已有验证限于 local mock、官方 CLI 隔离宿主和 Edge 合成桥接；真实生产联调未验证。六平台外部接口只经公开文档/公开代码核对，不等于真实六平台实测。

### 已安装旧版本时怎样更新

在 Magpie 插件管理页打开“添加插件 / 安装插件”，填入上面的固定 ref，确认安装。无需先卸载、删除账号或寻找“编辑来源”按钮。

已核对官方 0.1.3250 的 plugin.Add 实现：Git / npm 插件按实际包名识别，添加新 ref 会替换同包名旧条目，并保留 Options、启用状态和 Provider 偏好；该操作不删除认证存储。此结论适用于原条目也是本仓库 Git 安装的情况；本地路径条目需另核对，不能笼统保证自动合并。

固定旧 tag 的条目只点“更新”可能仍获取同一旧 tag。升级时应确认来源为 #v0.2.0；安装会重载共享插件宿主，影响进行中的请求和进程内会话亲和。关闭旧插件页并重新打开，改一项非秘密设置、保存、再次打开核对保留。保存设置不要求先登录 AIHub；真实模型使用才需要自己的账户或分组 Key。

安装后应看到插件“AIHub 自动路由”、上游 AIHub Auto / aihub-auto 及配置页。官方 Windows CLI 0.1.3250 隔离验证通过加载、合成凭据、六平台 8 个模型及三种 SDK 注册；不能据此宣布目标生产实例已通过。

若由用户自己在运行 Magpie 的同一账户、同一配置环境执行 CLI，可使用：

```sh
magpie plugin add github:abworks-dev/magpie-aihub#v0.2.0
magpie plugin login aihub-auto 1
magpie plugin --json
```

容器外另一用户的 CLI 不等于容器实例。优先使用现有官方管理页，不让运维 Agent 绕过文件权限。opc-agent 生产私有路径的拒绝不可通过其他路径、身份或复制凭据绕过。不要公开 Key、密码、认证 JSON 或完整诊断输出。

## 先使用手工分组 Key

1. 在 AIHub 准备两把**同平台、同模型**、固定分组且已限额的测试 Key；关闭自动改组，避免多套工具争用。
2. 在配置页启用目标平台，填写准确模型 ID、实际倍率上限与协议，暂不开启自动建 Key；手工模式保持“仅检测通过”关闭。
3. 在 AIHub Auto 连接界面选择“导入分组 Key”，私下填写 [README](../README.md#1-手工导入分组-key推荐首次验收) 的 JSON。每项 platform 与分组一致，省略时为 openai；multiplier 是实际账号倍率，models 为原始上游 ID。
4. 核对模型列表：OpenAI 保留原始 ID；其他平台使用 platform::model。openai / deepseek / zhipu / kimi / grok 选择 responses 或 chat；Gemini 选择 responses 或 gemini 原生协议。原生 Gemini 须显式选择，不凭模型名猜测；客户端发送完整历史。
5. 有明确小额费用预算后，才做真实短对话、取消、工具调用与会话保持验收。首字节前换组仍可能重复计费；平台之间不互相 failover，不换模型兜底。

两种认证方式均由自定义表单完成，不应另索要普通 API Key。若出现额外 Key 提示，核对插件版本与宿主认证表单并重新打开连接界面。

## 再考虑账户模式

账户模式需私下输入 AIHub 邮箱和密码，autoCreateKeys 默认 false。models 留空时从可用分组和大厅发现模型，不预先建 Key；上游页面点“重新获取模型”。原来保存过显式列表时先清空并保存。发现受平台与路由政策筛选，使用默认 API；Gemini 自动发现固定使用 Responses，原生 Gemini 需手工指定模型协议。

启用 autoCreateKeys 后，业务请求可创建专用分组 Key；尚未验证建 Key 的远端额度参数。请自行核实额度，插件不删除、改绑或清理其他 Key。移除插件不撤销远端 Key。pending 与稳定错误码的处理见 [自动化](automation.md) 和 [README](../README.md#只读监控与密钥错误)。

## 可选监控与 Cloud 边界

monitorEnabled 默认 false。monitorPort=19871 是默认候选，**尚未生产分配或确认可用**；先核对目标主机端口与宿主服务桥接，再启用。page.service 提供 127.0.0.1 的可选只读页面 / GET 快照，静态设置页通过 bridge.service 导航，不应直接暴露未经核对的公网监听。

Cloud 目前只批准四个静态资源，**没有批准 service 新路由**；不能将静态页可打开或 Edge 合成桥接通过解释为生产监控可用。遇 403/404 应记录精确方法/路径/状态，交由有权主体处理，不扩大整个 API 白名单或绕过 opc-agent 私有路径拒绝。

监控不发推理探测、不建 Key；GET 快照可能触发远端目录 GET 与管理令牌刷新/保存。只展示脱敏白名单字段，缺失指标 null；不是持久审计或六平台健康保证。

## 失败时怎样定位

| 现象 | 需要核对的非秘密信息 |
| --- | --- |
| Git 来源安装失败 | tag 是否已发布、Magpie 版本、Git spec、脱敏错误与实例到 GitHub 的连接 |
| 页面、监控或按钮 403/404 | 操作、HTTP 方法、精确路径/状态；静态与 service 授权分别核对 |
| 保存无响应 | 关闭旧页重新打开，核对 bridge；旧版表单沙箱问题曾在 0.1.2 修复 |
| 没有模型 / 没有候选 | 已认证、是否显式列表、启用平台、命名空间/协议、倍率/组名单/检测要求与目录权限 |
| key_not_imported / key_creation_disabled | 导入该组 Key，或确认创建副作用后启用自动创建 |
| key_pool_full / key_creation_pending / key_creation_incomplete / key_duplicate | 核对本实例专用名称、远端 Key、池大小与未知创建结果；不盲目重建或清理 |
| key_sign_in_required / key_access_denied / key_rate_limited / key_preparation_failed | 重新连接、核对权限/限流/管理接口状态；错误响应已脱敏 |
| 需要验证码 / 2FA | 转用手工 Key；不公开凭据 |

不要提供带登录 query、Authorization、Cookie 或完整 body 的截图/网络导出。安装、页面展示、目录发现、六平台真实计费请求和生产监控是分别验收的步骤。

## 隔离宿主复验（开发者）

使用官方固定 v0.1.3250 Windows amd64 CLI，放在本仓库忽略的 .local-validation 目录，在可执行文件旁创建 .portable，然后运行：

```powershell
./test/magpie-host-smoke.ps1
```

脚本核对官方 SHA256，设置隔离 HOME/config/cache、禁用账户发现，使用合成凭据验证加载、认证和模型 SDK。它会修改测试目录内便携配置，不能在现有真实安装旁运行；不发送推理或 AIHub 账号登录。CI 下载固定 CLI 执行同一脚本。浏览器、Go 网关链、真实平台接口和生产行为须分别验收，见 [验证记录](tests.md)。
