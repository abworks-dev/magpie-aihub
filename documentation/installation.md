# 安装与首次验收

## 安装

**v0.3.1 为预发布版本。** 在已登录的 Magpie 插件管理页添加以下 Git 来源：

```text
github:abworks-dev/magpie-aihub
```

不带 `#ref` 的写法跟随仓库 main，Magpie 的「更新」才会真正生效。需要复现固定版本时写 `github:abworks-dev/magpie-aihub#v0.3.1`（本版起为轻量标签）：固定 ref 会持续显示「有新版本」，因为 Magpie 比较仓库 HEAD 与已装 commit，而点更新不会改变 pin；这是宿主行为（[yetone/magpie#6952](https://github.com/yetone/magpie/issues/6952)）。

仓库公开，不需向插件提供 GitHub Token。服务器必须能访问 GitHub 及 Magpie 插件运行时。推理路由无需编译或新增代理监听；页面服务随插件启动，设置与只读监控在同一页面。已有验证限于 local mock、官方 CLI 隔离宿主和 Edge 合成代理；真实生产联调未验证。六平台外部接口只经公开文档/公开代码核对，不等于真实六平台实测。

### 已安装旧版本时怎样更新

在 Magpie 插件管理页打开“添加插件 / 安装插件”，填入上面的固定 ref，确认安装。无需先卸载、删除账号或寻找“编辑来源”按钮。

已核对官方 0.1.3250 的 plugin.Add 实现：Git / npm 插件按实际包名识别，添加新 ref 会替换同包名旧条目，并保留 Options、启用状态和 Provider 偏好；该操作不删除认证存储。此结论适用于原条目也是本仓库 Git 安装的情况；本地路径条目需另核对，不能笼统保证自动合并。

固定旧 tag 的条目只点“更新”会重复获取同一 ref；升级时应把来源改为不带 ref 的形式，或改成新版本号。安装会重载共享插件宿主，影响进行中的请求和进程内会话亲和。关闭旧插件页并重新打开，改一项非秘密设置、保存、再次打开核对保留。保存设置不要求先登录 AIHub；真实模型使用才需要自己的账户或分组 Key。

**插件更新不需要重启 Magpie 容器。** 安装、更新或改设置都会触发一次插件宿主重载：当前 Bun 子进程退休，下一次调用或打开插件页时用新代码重新拉起（`internal_gui_pluginpage.go` 的 Restart 说明与本节开头一致）。因此：

- 只改 `ui/`：硬刷新页面即可，静态文件直接读盘。
- 改 `src/`、`index.mjs` 或依赖：跑一次 `magpie plugin update …`，再打开插件页触发预热、`Ctrl+F5`。宿主重载会停掉页面服务，首次打开可能需要再刷一次。
- 仅以下情况才 `docker restart`：注入给容器的环境变量变化（`MAGPIE_HTTPS_PROXY` 等只在进程启动时读）、Magpie 本体升级、插件清单结构变化（新增页面或服务注册）、或宿主明显没被换掉、多次刷新仍不工作时兜底。

安装后应看到插件“AIHub 自动路由”、上游 AIHub Auto / aihub-auto 及配置页。官方 Windows CLI 0.1.3250 隔离验证通过加载、合成凭据、六平台 8 个模型及三种 SDK 注册；不能据此宣布目标生产实例已通过。

若由用户自己在运行 Magpie 的同一账户、同一配置环境执行 CLI，可使用：

```sh
magpie plugin add github:abworks-dev/magpie-aihub
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

启用 autoCreateKeys 后，业务请求可创建专用分组 Key；尚未验证建 Key 的远端额度参数。请自行核实额度，插件不删除、改绑或清理其他 Key。移除插件不撤销远端 Key。pending 与稳定错误码的处理见 [自动化](automation.md) 和 [README](../README.md#页面只读监控与密钥错误)。

## 页面服务与 Cloud 边界

设置与监控是同一个页面，由插件自己的 page.service 在 127.0.0.1 提供；`monitorPort=19871` 是默认候选，**尚未生产分配或确认可用**。先核对目标主机端口与宿主服务桥接。`magpie web` 会把服务代理到插件页面路径下，从其他机器经 Magpie 即可打开监控；桌面版 Magpie 不代理服务，页面会提示在本机访问 `http://127.0.0.1:<monitorPort>/`。不应直接暴露未经核对的公网监听。

Cloud 目前只批准四个静态资源，**没有批准 service 新路由**；不能将静态页可打开或 Edge 合成代理通过解释为生产监控可用。遇 403/404 应记录精确方法/路径/状态，交由有权主体处理，不扩大整个 API 白名单或绕过 opc-agent 私有路径拒绝。

若部署在自带反向代理的入口后面（例如 `magpie.abworks.cn` 由 Caddy 指向 `magpie web`），代理只放行插件静态文件时，监控标签会导航到 `/_magpie/plugin/<32 位 token>/_magpie/service/` 并被代理的兜底 404 截断。需要让代理把该前缀整体转发给同一个 `magpie web` 上游（保持路径与查询不变，不剥离前缀，建议关闭缓冲以便将来 SSE）：

```caddyfile
@magpie_plugin_service path_regexp svc ^/_magpie/plugin/[0-9a-f]{32}/_magpie/service(?:/.*)?$
handle @magpie_plugin_service {
    reverse_proxy 127.0.0.1:<magpie-web-port> {
        flush_interval -1
    }
}
```

`/_magpie/service/` 与 `/_magpie/plugin/<token>/_magpie/service/` 都应命中同一条规则；改完后用 `curl -sS -o /dev/null -w "%{http_code}\n"` 核对无效 token 返回 Magpie 自己的 `404 page not found`（而不是代理的 HTML/纯文本 404），再用真实插件页点「监控」。

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
| key_sign_in_required / key_session_expired / key_access_denied / key_rate_limited / key_preparation_failed | 重新连接、核对权限/限流/管理接口状态；错误响应已脱敏 |
| 需要验证码 / 2FA | 转用手工 Key；不公开凭据 |

不要提供带登录 query、Authorization、Cookie 或完整 body 的截图/网络导出。安装、页面展示、目录发现、六平台真实计费请求和生产监控是分别验收的步骤。

## 隔离宿主复验（开发者）

使用官方固定 v0.1.3250 Windows amd64 CLI，放在本仓库忽略的 .local-validation 目录，在可执行文件旁创建 .portable，然后运行：

```powershell
./test/magpie-host-smoke.ps1
```

脚本核对官方 SHA256，设置隔离 HOME/config/cache、禁用账户发现，使用合成凭据验证加载、认证和模型 SDK。它会修改测试目录内便携配置，不能在现有真实安装旁运行；不发送推理或 AIHub 账号登录。CI 下载固定 CLI 执行同一脚本。浏览器、Go 网关链、真实平台接口和生产行为须分别验收，见 [验证记录](tests.md)。
