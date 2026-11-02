# Dedicated 能力迁移回归复盘

## 根因

本次问题不是架构迁移必须付出的功能代价，而是组合层没有保持原有能力契约：

1. Dashboard 把 `architecture === 'platform'` 直接作为简化接入界面的条件，
   将 Dedicated 一并切入只有邀请命令的分支，高级运行模式和权限配置被绕过。
2. 权限、产品形态与配置持久化混在一起。将文件配置迁到组织级存储时，
   曾用“Operator 管理”替代实际模型编辑，没有保留用户配置链路。
3. 组合入口没有逐项传递原 Host 的选项。Runtime Service 没有加载并传入
   `hooks` / `hookRunner`，使只读 Hooks 页面背后的实际执行也丢失；
   最终镜像还没有 `/bin/sh`，仅补回函数调用也不能运行原有 shell 命令。
4. 共享安装资源实例被当作真实租户计入 Unit 名额。Dedicated 的真实租户加载后，
   安装实例无法进入容量为 1 的注册表，安装资源下载被误报为租户不存在。
5. 名额豁免仍不足以恢复下载：安装实例还继承了租户 Copilot 的 PG 原生存储配置，
   却没有相应的外部 Session authority，初始化因此失败。必须同时隔离安装资源的
   运行配置，不能只提高容量或改写错误响应。
6. 验收偏重页面可见和进程健康；缺少“选择选项 → 安装执行”和
   “保存 → Runtime 重建 → 再读”的能力验收，部分测试甚至断言高级选项应当不存在。

## 已修复能力与约束

| 能力 | 修复 | 必须保持的边界 |
|---|---|---|
| 模型、Base URL、API Key、模型元数据 | Settings → Models 直接编辑，组织级加密持久化并动态更新模型路由 | 密钥不回显；留空保留已存密钥；模型引用和默认模型不被意外替换 |
| 账户资料 | 显示经 OIDC 验证的真实登录资料并持久化浏览器资料 | 不修改 Dedicated 的不可变 Owner 授权主体 |
| 工作区浏览 | 普通用户可查看有权访问的工作区，邀请管理单独鉴权 | 浏览不请求管理员专属邀请 API |
| Connect Workspace 高级设置 | 所有接入形态共用选项组件；模式和权限进入实际组织邀请安装器 | 不恢复匿名全局配对，不因换选项重复生成邀请 |
| Linux 邀请服务安装 | 先组织绑定注册，再使用现有 systemd 服务计划和私有凭据文件 | 保存工作区 ID、路由提示和安装来源；拒绝覆盖现有安装 |
| 安装资源下载 | 共享只读安装资源不占租户 Unit 名额，也不启用租户 Copilot/PG 原生存储 | Dedicated 仍只允许一个真实租户 Unit；不能因为它已加载或共享实例没有租户存储就让下载返回 404 |
| macOS 服务安装 | 组合现有 launchd 适配器，不再误调用 Linux systemctl | 配置和凭据私有；真实 macOS 接受测试须在 macOS runner 上完成 |
| 受限服务 | Linux 非 root 用户服务应用 `NoNewPrivileges=yes` | root 受限服务拒绝安装；macOS/Windows 尚无对应隔离实现，选项明确禁用并解释 |
| Hooks 执行 | 按 Runtime Unit 加载配置、传入实际 HookRunner，并补齐镜像中的 POSIX shell | Private Cloud 不共用跨组织策略；Dedicated 可显式指定 Operator 配置；缺失或无效的显式策略报错 |
| 原生可观测性 | 现有管理区域给出 Aspire 原生访问地址和限制，保留官方 Socket.IO Admin | 不在 Kala 导出/重绘 Aspire 数据，不绕过认证或新增公开端口 |
| 存储呈现 | 文件数、可读容量、预留和配额分开，标注统计范围并手动刷新 | 不伪称为整个 PostgreSQL/S3/工作区的磁盘统计 |

## 其他 Settings 能力检查

对 Runtime、Agent、Connection、Security、Socket.IO、MCP、Web Search、
Speech、Storage 的 UI → API → 持久化/执行路径进行了对照。除上述 Hooks
漏接外，未在这些检查路径中确认其他高置信功能丢失。这不是对未覆盖路径的
“零回归”保证。

- Runtime 重建由部署 Operator 管理，是有意的权限边界，不冒充租户内重启按钮。
- Agent 槽位保存在组织级 PostgreSQL，并同步已有 Session 和后续 Session。
- Connection 的端点覆盖是浏览器连接设置，不是所有管理 HTTP API 的任意迁移入口。
- MCP 需要已连接且受管理的 Executor，其配置需要实际确认并由 Executor 保存。
- Web Search 和 Speech 复用组织绑定的加密凭据存储；空密钥保留已有秘密。
- Dedicated Owner 不意味着 Private Cloud 普通组织管理员有全局部署管理权限。

## 后续修改的验收原则

每一项能力至少核对入口、权限、请求参数、保存位置、重建恢复和实际执行结果。
操作系统能力必须区分“服务计划测试通过”和“目标系统真实安装通过”，不能混报。
健康检查、截图和布局测试都不能替代这条能力链路。

Runtime 镜像现已提供 Hooks 所需的 POSIX shell，而不是只接回函数调用。
镜像从仓库锁定的官方 Node 构建阶段复制 Debian `dash` 和版权文件；
不另装未知软件。其他 Hook 命令依赖仍须由 Operator 在镜像中明确提供。
在实际 Dedicated 容器中，配置加载、JSON stdin、允许退出和非零阻断均已生效。
检查当前及已退役 Dedicated 的配置挂载和旧 Operator 配置路径后，
未发现需要迁移的已有 Hooks 配置块。

Linux Dedicated 的真实服务安装、长期凭据切换、服务重启重连和安装资源下载
已实际执行。macOS 目前验证的是 launchd 计划和私有文件写入，不冒充真实 macOS 验收。

扩大检查时还发现 6 个现有测试失败，已用未修改的 `ed302c30` 源码快照复现：
4 个旧的 Socket.IO 组合测试认证失败，2 个 Secret 环境配置断言失败。
这些不是本次补丁引入的失败，也不据此宣称全套测试通过。
