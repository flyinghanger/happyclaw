# HappyClaw 远程无缝衔接方案提案

## 1. 背景与痛点

HappyClaw 目前作为本地部署的多用户 AI Agent 平台，提供了 Web UI、飞书、Telegram 三种交互入口。但存在一个核心体验问题：

**用户在本地电脑通过 Web UI 开始工作后，离开电脑（出门、换设备）时，无法无缝继续当前工作。**

具体表现：
- Web UI 绑定在 `localhost:3000`，离开局域网后不可访问
- 飞书/Telegram 虽然随时可用，但 IM 消息**只能路由到用户 home folder 的主对话**
- 用户在 Web 上可能开了多个工作区（Group）和多个对话（Agent Conversation），IM 侧完全无法感知和切换
- 回到电脑后，IM 里的对话和 Web 上的对话是割裂的

## 2. 现有架构分析

### 2.1 数据模型

```
registered_groups 表:
┌───────────────────┬─────────────┬─────────┐
│ jid (主键)         │ folder      │ is_home │
├───────────────────┼─────────────┼─────────┤
│ web:main          │ main        │ 1       │  ← 管理员主工作区
│ web:project-x     │ project-x   │ 0       │  ← 项目工作区
│ feishu:chat-abc   │ main        │ 0       │  ← IM 自动绑定到 home folder
└───────────────────┴─────────────┴─────────┘

sessions 表 (复合主键: group_folder + agent_id):
┌──────────────┬──────────┬────────────────────┐
│ group_folder │ agent_id │ session_id         │
├──────────────┼──────────┼────────────────────┤
│ main         │ ''       │ claude-session-aaa │  ← 主对话
│ main         │ uuid-aaa │ claude-session-bbb │  ← 对话 "API开发"
│ project-x    │ ''       │ claude-session-ccc │  ← project-x 主对话
└──────────────┴──────────┴────────────────────┘

agents 表:
┌──────────┬──────────────┬──────────┬───────────────┬────────┐
│ id       │ group_folder │ chat_jid │ name          │ kind   │
├──────────┼──────────────┼──────────┼───────────────┼────────┤
│ uuid-aaa │ main         │ web:main │ API开发        │ conversation │
│ uuid-bbb │ main         │ web:main │ 前端重构       │ conversation │
└──────────┴──────────────┴──────────┴───────────────┴────────┘
```

### 2.2 IM 消息路由现状

```
飞书消息 → feishu:chat-abc (folder=main) → processGroupMessages() → 主对话 session
                                              ↑
                                         永远只路由到主对话，
                                         无法触达 agent conversation，
                                         无法切换到其他 Group
```

关键代码路径：
- `src/index.ts:buildOnNewChat()` — IM 新聊天自动注册，`folder` 固定为用户的 `homeFolder`
- `src/index.ts:handleCommand()` — IM 斜杠命令处理，目前仅支持 `/clear`
- `src/index.ts:processGroupMessages()` — 按 `chat_jid` 路由消息，IM 和 Web 的 agent conversation 完全隔离
- `src/im-channel.ts:onCommand` — IM 斜杠命令回调机制已存在

### 2.3 已有的有利条件

- 同一个 `folder` 下的所有 JID 共享 Claude Session（`data/sessions/{folder}/.claude/`）
- `registered_groups` 表的 `folder` 字段已移除 UNIQUE 约束，允许多个 JID 共享同一 folder
- `agents` 表支持 `kind='conversation'` 的多对话，每个对话有独立 session（复合主键 `group_folder + agent_id`）
- 虚拟 JID 机制已存在：`{chatJid}#agent:{agentId}`
- IM 的 `onCommand` 回调链路已通，飞书/Telegram → `im-channel.ts` → `im-manager.ts` → `index.ts:handleCommand()`

---

## 3. 方案一：IM 指令切换（短期方案，建议立即实施）

### 3.1 核心思路

**利用现有 IM 作为免费的远程中继层**，通过扩展 IM 斜杠命令，让用户在飞书/Telegram 中切换工作区和对话。

优势：
- 不需要额外服务器、不需要公网暴露、不需要反向代理
- 飞书/Telegram 的服务器天然充当消息中继
- 用户手机上已有 IM App，无需安装任何新软件
- 推送通知由 IM 平台提供（Agent 回复自动推送）

### 3.2 新增 IM 命令

| 命令 | 功能 | 示例 |
|------|------|------|
| `/list` | 列出所有可访问的工作区及其对话 | `/list` |
| `/switch <目标>` | 切换到指定工作区或对话 | `/switch project-x` 或 `/switch API开发` |
| `/new <名称>` | 在当前工作区创建新对话 | `/new 数据库设计` |
| `/status` | 显示当前绑定的工作区和对话 | `/status` |
| `/clear` | 清除当前对话上下文（已有） | `/clear` |

### 3.3 交互示例

```
用户 (飞书): /list
Bot:
  📂 工作区列表:
  ─────────────────
  ▶ main (当前)
    ├─ 主对话 ← 当前
    ├─ API开发 [运行中]
    └─ 前端重构 [空闲]
  ─────────────────
    project-x
    ├─ 主对话
    └─ Schema设计

用户: /switch API开发
Bot: ✅ 已切换到 main / API开发

用户: 继续昨天的接口开发，加上分页参数
Bot: (带着 "API开发" 对话的完整上下文继续工作)

用户: /switch project-x
Bot: ✅ 已切换到 project-x / 主对话

用户: /new 性能优化
Bot: ✅ 已在 project-x 下创建对话「性能优化」并切换
```

### 3.4 技术实现

#### 3.4.1 新增内存状态

```typescript
// src/index.ts

// IM JID 的当前活跃目标
interface ImTarget {
  folder: string;         // 当前绑定的工作区 folder
  agentId: string | null; // 当前绑定的对话 (null = 主对话)
}

const imTargets: Record<string, ImTarget> = {};
// 例: { "feishu:chat-abc": { folder: "main", agentId: null } }
```

#### 3.4.2 扩展 handleCommand

```typescript
// src/index.ts handleCommand() 扩展

async function handleCommand(chatJid: string, command: string): Promise<string | null> {
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case 'clear':
      // ... 现有逻辑
    case 'list':
      return handleListCommand(chatJid);
    case 'switch':
      return handleSwitchCommand(chatJid, arg);
    case 'new':
      return handleNewCommand(chatJid, arg);
    case 'status':
      return handleStatusCommand(chatJid);
    default:
      return null;
  }
}
```

#### 3.4.3 消息路由改造

当 IM 消息不是命令时，检查 `imTargets` 判断投递目标：

```typescript
// src/index.ts 消息处理流程改造（伪代码）

function routeImMessage(chatJid: string, message: NewMessage) {
  const target = imTargets[chatJid];

  if (!target) {
    // 默认行为：路由到 home folder 主对话（兼容现有逻辑）
    return { targetJid: chatJid, agentId: null };
  }

  if (target.agentId) {
    // 路由到 agent conversation → 使用虚拟 JID
    const virtualJid = `${getGroupJidByFolder(target.folder)}#agent:${target.agentId}`;
    return { targetJid: virtualJid, agentId: target.agentId };
  }

  // 路由到目标 folder 的主对话
  return { targetJid: getGroupJidByFolder(target.folder), agentId: null };
}
```

#### 3.4.4 回复路由

Agent 回复时，需要同时推送到 IM 渠道：

```typescript
// 在 agent 回复回调中，检查是否有 IM 绑定到当前对话
function onAgentReply(chatJid: string, agentId: string | null, text: string) {
  // 1. 正常 Web 广播（现有逻辑）
  broadcastNewMessage(chatJid, ...);

  // 2. 检查是否有 IM 绑定到此目标，如果有则推送
  for (const [imJid, target] of Object.entries(imTargets)) {
    if (target.folder === folderOf(chatJid) && target.agentId === agentId) {
      imManager.sendMessage(imJid, text);
    }
  }
}
```

### 3.5 改动范围估算

| 文件 | 改动内容 | 预估代码量 |
|------|---------|-----------|
| `src/index.ts` | 扩展 `handleCommand`，新增 `/list` `/switch` `/new` `/status` | ~100 行 |
| `src/index.ts` | 消息路由改造，检查 `imTargets` | ~30 行 |
| `src/index.ts` | 回复推送到绑定的 IM 渠道 | ~20 行 |
| `src/db.ts` | 新增查询：`listAccessibleGroups(userId)`、`listAgentsByFolder(folder)` | ~20 行 |
| `src/commands.ts` | 抽取通用命令逻辑 | ~40 行 |
| **合计** | | **~210 行** |

### 3.6 不需要改动的部分

- 飞书/Telegram 连接层（`feishu.ts` / `telegram.ts`）— `onCommand` 机制已存在
- `im-channel.ts` / `im-manager.ts` — 命令回调链路已通
- Agent conversation 处理逻辑（`processAgentConversation`）— 虚拟 JID 机制已就位
- 前端代码 — 无需任何改动
- 数据库 schema — 无需新增表或字段

### 3.7 限制

- IM 端无法看到 Agent 的实时 streaming 过程（只能看到最终回复）
- IM 端无法使用文件管理、Web Terminal 等 Web 专属功能
- 切换状态存在内存中，服务重启后需重新 `/switch`（可后续持久化）
- 受限于 IM 平台的消息长度和格式（长代码输出可能被截断）

---

## 4. 方案二：Happy 中继架构迁移（中长期方案）

### 4.1 Happy 架构概述

[Happy](https://github.com/slopus/happy) 是一个跨设备无缝切换的 AI Agent 远程控制平台，核心架构：

```
本地电脑 (Happy CLI)  ←──Socket.IO──→  云中继服务器  ←──Socket.IO──→  手机 App
     │                                    │                              │
  Claude Code                         加密中转                      实时看+控制
     │                                PostgreSQL                    Push 通知
  本地/远程模式秒切                      Redis                     原生 iOS/Android
```

关键技术特性：
- **E2E 加密**：TweetNaCl (Curve25519 + XSalsa20-Poly1305)，服务端零知识
- **实时同步**：Socket.IO 三种连接类型 (session-scoped / machine-scoped / user-scoped)
- **RPC 机制**：手机 App 通过服务端 RPC 转发控制本地 CLI
- **Daemon 进程**：后台常驻，支持手机远程启动新 Session
- **本地/远程模式切换**：按任意键即可在两种模式间切换，零数据丢失

### 4.2 为什么需要迁移到 Happy 架构

方案一（IM 指令切换）能解决 80% 的场景，但存在天花板：

| 维度 | IM 方案 | Happy 中继方案 |
|------|---------|--------------|
| 实时 Streaming | ❌ 只能看最终结果 | ✅ 实时看到 Agent 思考和工具调用 |
| 富交互 | ❌ 纯文本，受 IM 格式限制 | ✅ 完整 Web UI / 原生 App |
| 文件操作 | ❌ 无法浏览/上传文件 | ✅ 完整文件管理 |
| 代码展示 | ❌ IM 对代码块支持有限 | ✅ 语法高亮、diff 展示 |
| 安全性 | ⚠️ 消息经过 IM 平台明文传输 | ✅ E2E 加密，服务端零知识 |
| 推送通知 | ✅ IM 原生支持 | ✅ 需自建 (Expo Push) |
| 多用户隔离 | ✅ HappyClaw 已有 | ✅ 保留 |
| 部署成本 | ✅ 零额外成本 | ⚠️ 需要云服务器 |

### 4.3 迁移架构设计

目标：将 Happy 的远程接入层嫁接到 HappyClaw 上，保留 HappyClaw 的全部企业功能。

```
┌─────────────────────────────────────────────────────────────┐
│                    HappyClaw + Happy 融合架构                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  接入层 (新增)                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Web PWA  │  │ 飞书/TG  │  │ 移动 App │  │ Happy CLI  │ │
│  │ (现有)    │  │ (现有)    │  │ (新增)    │  │ (新增)      │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬─────┘ │
│       │              │              │               │       │
│  ─────┼──────────────┼──────────────┼───────────────┼────── │
│       │              │              │               │       │
│  中继层 (新增)        │              │               │       │
│  ┌────┴──────────────┴──────────────┴───────────────┴────┐ │
│  │              WebSocket 中继网关                         │ │
│  │              ├─ E2E 加密                               │ │
│  │              ├─ RPC 路由                                │ │
│  │              ├─ Session 同步                            │ │
│  │              └─ Push 通知                               │ │
│  └───────────────────────┬───────────────────────────────┘ │
│                          │                                  │
│  ─────────────────────────┼─────────────────────────────── │
│                          │                                  │
│  核心层 (现有 HappyClaw)  │                                  │
│  ┌───────────────────────┴───────────────────────────────┐ │
│  │  HappyClaw Server                                     │ │
│  │  ├─ 多用户 RBAC                                       │ │
│  │  ├─ Group / Agent Conversation 管理                   │ │
│  │  ├─ Docker 沙箱执行                                    │ │
│  │  ├─ 飞书/Telegram 集成                                 │ │
│  │  ├─ 定时任务调度                                       │ │
│  │  ├─ Skills / MCP 生态                                  │ │
│  │  └─ 文件管理 / Web Terminal                            │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  数据层 (升级)                                               │
│  ┌────────────┐  ┌───────┐  ┌──────────────────┐          │
│  │ PostgreSQL │  │ Redis │  │ Object Storage   │          │
│  │ (替代SQLite)│  │ (队列) │  │ (加密文件/产物)   │          │
│  └────────────┘  └───────┘  └──────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 4.4 分阶段实施路线

#### Phase 1：基础设施升级（预计 2-3 周）

| 任务 | 说明 | 优先级 |
|------|------|--------|
| SQLite → PostgreSQL | 使用 Prisma 替换 better-sqlite3，支持 PostgreSQL(生产) + PGlite(本地开发) | P0 |
| 内存队列 → Redis | BullMQ 管理任务队列，Redis Pub/Sub 实现跨实例广播 | P0 |
| Docker Compose 编排 | 替代裸 `docker run`，添加资源限制和健康检查 | P1 |
| 配置外部化 | 敏感配置迁移到环境变量 / Secrets Manager | P1 |

**里程碑**：HappyClaw 可部署到云服务器，支持公网 HTTPS 访问。

#### Phase 2：中继网关层（预计 3-4 周）

| 任务 | 说明 | 可复用 Happy 组件 |
|------|------|-----------------|
| E2E 加密模块 | 移植 TweetNaCl 加密层，消息端到端加密 | `happy-cli/src/api/encryption.ts` (可直接提取) |
| WebSocket 中继网关 | Socket.IO 公网网关，支持多设备实时同步 | `happy-server/sources/app/api/socket.ts` (参考实现) |
| RPC 路由 | 跨设备命令转发（手机控制 → 服务端 → 本地执行） | `happy-server/sources/app/api/socket/rpcHandler.ts` |
| 公钥认证 | 设备级免密认证 + 扫码登录 | `happy-server/sources/app/auth/auth.ts` |
| Session 同步协议 | 实时同步 Agent 执行状态到所有连接的设备 | `happy-wire/src/sessionProtocol.ts` |

**里程碑**：Web UI 可通过公网访问，多设备实时同步 Agent 状态。

#### Phase 3：移动端 + 产品化（预计 4-6 周）

| 任务 | 说明 | 可复用 Happy 组件 |
|------|------|-----------------|
| 移动 App | 基于 Expo，接入 HappyClaw API | `happy-app/` (参考架构和 sync engine) |
| Push 通知 | Agent 完成/出错/需审批时推送 | `happy-server/sources/app/api/routes/pushRoutes.ts` |
| Daemon 进程 | 远程启动新 Session，后台保活 | `happy-cli/src/daemon/run.ts` (参考模式) |
| 计费/配额 | 按用户 token 用量、容器时长计费 | 需全新开发 |

**里程碑**：完整的跨端产品体验，支持 iOS/Android 原生 App。

### 4.5 Happy 可复用组件评估

| 组件 | 可移植性 | 复杂度 | 说明 |
|------|---------|--------|------|
| E2E 加密模块 | ⭐⭐⭐⭐⭐ | 低 | 纯加密函数库，无外部依赖，可直接提取为 npm 包 |
| Daemon 模式 | ⭐⭐⭐⭐⭐ | 中 | 通用后台进程模式，PID 追踪 + 心跳 + RPC，概念完全可移植 |
| RPC 路由 | ⭐⭐⭐⭐ | 中 | Socket.IO 双向 RPC 转发，需适配 HappyClaw 的权限模型 |
| 公钥认证 | ⭐⭐⭐⭐ | 中 | 基于 libsodium，需与 HappyClaw 现有密码认证体系整合 |
| Session 同步协议 | ⭐⭐⭐⭐ | 高 | Zod schema + 乐观版本控制，需适配 HappyClaw 的 Group/Agent 模型 |
| 移动 App | ⭐⭐⭐ | 高 | Expo 框架可复用，但 UI 和业务逻辑需完全重写 |
| Push 通知 | ⭐⭐⭐ | 低 | 依赖 Expo Push Service，需 App 端配合 |

### 4.6 架构决策点

在迁移过程中需要做出的关键决策：

**1. 中继服务器部署模式**
- **选项 A**：自托管（用户自己部署中继服务器） — 适合企业用户，数据完全自控
- **选项 B**：SaaS 托管（项目方提供中继服务） — 适合个人用户，开箱即用
- **建议**：两种模式都支持，默认 SaaS + 可选自托管

**2. Web UI 公网方案**
- **选项 A**：当前 Web UI 直接公网化（加 HTTPS + Auth 加固）
- **选项 B**：保持 Web UI 本地，新建独立的远程 Web Client
- **建议**：选项 A，改造成本更低

**3. IM 集成是否保留**
- **建议**：保留。IM 方案和中继方案不冲突，IM 适合轻量交互（快速指令、通知查看），App 适合深度操作

---

## 5. 推荐实施路径

```
       现在                  1-2 周              1-2 月              3-6 月
        │                     │                   │                   │
        ▼                     ▼                   ▼                   ▼
   ┌─────────┐          ┌──────────┐        ┌──────────┐       ┌──────────┐
   │ 方案一   │          │ 方案一   │        │ Phase 1  │       │ Phase 2-3│
   │ IM 指令  │───实施──→│ 上线     │──并行──→│ 基础设施 │──────→│ 中继+App │
   │ 切换     │          │ 解决80%  │  启动   │ 升级     │       │ 产品化   │
   └─────────┘          │ 痛点     │        └──────────┘       └──────────┘
                        └──────────┘
```

**建议**：
1. **立即实施方案一**（IM 指令切换），~210 行代码改动，1-2 周可上线
2. **并行启动方案二 Phase 1**（基础设施升级），为后续中继架构打基础
3. **根据用户反馈和产品方向**，决定 Phase 2-3 的优先级和投入

方案一和方案二不冲突，方案一上线后即使不做方案二，也能显著改善远程使用体验。方案二是面向产品化的长期投资。

---

## 6. 参考项目

- **Happy**: https://github.com/slopus/happy — 跨设备 AI Agent 远程控制平台
- **HappyClaw**: https://github.com/flyinghanger/happyclaw — 自部署多用户 AI Agent 平台
