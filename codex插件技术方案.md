# Codex Companion — 项目讨论记录与技术决策

> **日期**：2026-03-18
> **状态**：技术选型讨论中（尚未开始写代码）

---

## 一、项目背景

OpenAI Codex 发布了桌面端应用和 VS Code 插件，能够与 AI 对话后生成/修改代码。但官方工具存在以下核心缺陷：

1. **无法逐块确认代码变更** — 只能整体接受或撤销，不能选择性 accept/reject 某些代码块
2. **Undo 功能有 bug** — 撤销代码变更时会自动将文件 stage 到 git，干扰开发者的 git 工作流
3. **无法看到变更全貌** — 不清楚 AI 到底改了哪些文件、每个文件改了什么
4. **会话历史丢失** — 重启 VS Code 后对话记录消失

---

## 二、方案演变过程

| 阶段 | 方案 | 结论 |
|------|------|------|
| 最初 | 做一个 Electron 独立桌面应用（类似 Cursor） | ❌ 工作量太大，相当于重做一个 IDE |
| 中间 | 直接给 Codex 提 PR | ❌ Codex IDE 插件不开源（只有 CLI 和 App Server 开源） |
| **最终** | **做一个独立的 VS Code 伴侣扩展** | ✅ 与官方插件配合使用，最务实 |

---

## 三、项目定位

- **项目名**：`codex-companion`
- **类型**：VS Code Extension
- **定位**：Codex 官方插件的"伴侣扩展"，不替代官方，提供增量能力
- **用户使用方式**：同时安装 Codex 官方插件 + Codex Companion

---

## 四、四大核心功能

### 功能 1：Diff 预览 + 逐块 Accept/Reject

- 监控文件变化 → 对比快照 → 用 VS Code 内置 Diff Editor 展示
- 用户可以逐文件、逐代码块决定是否保留 AI 的修改
- 使用 `TextDocumentContentProvider` 提供"变更前"的虚拟文档
- 使用 `vscode.diff` 命令打开 Diff 视图

### 功能 2：Checkpoint 快照回滚

- 像游戏存档点一样，每次 AI 改代码前自动保存文件状态
- 不满意可以一键回滚，**完全不碰 git**
- 侧边栏展示 Checkpoint 时间线，支持回滚到任意历史节点
- 支持单文件回滚和全量回滚

### 功能 3：变更摘要面板

- 侧边栏 TreeView，展示每次 AI 操作涉及的文件列表
- 清晰标注：修改（📝）、新增（✅）、删除（🗑️）
- 点击文件行直接打开 Diff 视图
- 显示行数变化统计（如 `[+15 -3]`）

### 功能 4：会话历史持久化

- 解析 Codex 本地存储的 `rollout.jsonl` 文件
- WebView 面板提供搜索和浏览界面
- 支持导出为 Markdown 文件

---

## 五、集成方式选择

讨论了两种与 Codex 集成的方式：

### 方式 A：文件系统监听（✅ 已选择，带改进）

- 使用 VS Code 的 `FileSystemWatcher` 监控工作区文件变化
- **关键改进**：扩展启动时将工作区文件读入内存作为"基准快照"，后续用基准快照对比，不依赖 git
- 用户每次保存文件时更新基准快照，避免将用户手动改动误判为 AI 改动

**优点**：
- 与官方插件完全解耦，兼容性最好
- 不怕官方更新导致失效
- 实现简单，全是 Node.js 标准 API
- 不依赖 git 环境

**缺点（可控）**：
- 内存占用：大项目需要过滤 node_modules 和二进制文件
- 无法实时感知 AI 正在处理中的状态
- 扩展启动时有冷启动开销（异步加载解决）

### 方式 B：直连 Codex App Server（❌ 暂不采用）

- 通过 JSON-RPC 2.0 协议直接与 App Server 通信
- 能在 AI 下手之前就拦截并展示变更
- **问题**：与官方插件可能冲突（两个客户端同时连 App Server），实现复杂
- **保留为未来升级路径**

---

## 六、已确定的技术选型

| 决策项 | 选择 | 说明 |
|--------|------|------|
| 整体方案 | 独立 VS Code 伴侣扩展 | 与官方插件配合，不替代 |
| 集成方式 | 改进版方式 A（内存快照 + FileSystemWatcher） | 不依赖 git，准确度高 |
| 主语言 | TypeScript | VS Code 扩展标准语言 |
| 构建工具 | **esbuild**（统一处理扩展主体 + WebView） | 一个脚本两个 entry，简单统一 |
| WebView 框架 | **React** | 用于会话历史面板等 WebView 页面 |
| 快照存储 | **VS Code `storageUri`** | 按工作区自动隔离，不污染项目目录 |

---

## 七、待讨论的技术选型（下次继续）

### 问题 4：内存快照的文件过滤策略（未回答）

扩展启动时读入内存的基准快照需要过滤无关文件，三个选项：

- **选项 A**：读取 `.gitignore` 规则，凡是 git 忽略的就跳过
- **选项 B**：写死白名单，只快照常见代码文件（`.ts`、`.js`、`.py`、`.go` 等）
- **选项 C**：A + B 结合，先用 `.gitignore` 过滤，再只保留文本文件

### 后续可能还需要讨论的问题

- 批量变化检测的阈值（几个文件同时变化才认为是 AI 操作？）
- 是否需要支持非 git 项目
- Diff Editor 中逐 hunk accept/reject 的具体交互方式
- 会话历史面板的 UI 设计细节
- 测试策略

---

## 八、开发阶段规划

| 阶段 | 目标 | 预估时间 |
|------|------|----------|
| Phase 1 | MVP — FileWatcher + Checkpoint + 基本 Diff + 侧边栏 | 1-2 周 |
| Phase 2 | Hunk 级 Accept/Reject + 单文件 Revert + 时间线 | 1 周 |
| Phase 3 | 会话历史 WebView + rollout.jsonl 解析 + 导出 | 1 周 |
| Phase 4 | 打磨配置项、错误处理、README、发布 Marketplace | 1 周 |

---

## 九、项目目录结构（初步）

```
codex-companion/
├── package.json
├── tsconfig.json
├── esbuild.js                       # 一个脚本打包两个 entry
├── src/
│   ├── extension.ts                 # 入口
│   ├── checkpoint/
│   │   ├── types.ts
│   │   ├── CheckpointManager.ts
│   │   ├── SnapshotStore.ts
│   │   └── FileWatcher.ts
│   ├── diff/
│   │   ├── CheckpointContentProvider.ts
│   │   ├── DiffViewManager.ts
│   │   └── HunkManager.ts
│   ├── views/
│   │   ├── CheckpointTreeProvider.ts
│   │   └── CheckpointTreeItem.ts
│   ├── webview/                     # React WebView（esbuild 打包为浏览器产物）
│   │   ├── App.tsx
│   │   ├── HistoryPanel.tsx
│   │   └── index.tsx
│   ├── history/
│   │   ├── RolloutParser.ts
│   │   ├── HistoryManager.ts
│   │   └── HistoryExporter.ts
│   └── utils/
│       ├── config.ts
│       ├── logger.ts
│       └── pathUtils.ts
├── media/
│   └── history.html
├── resources/icons/
└── test/
```

---

## 十、相关参考资料

- [Codex App Server 协议](https://developers.openai.com/codex/app-server/) — JSON-RPC 2.0 双向通信
- [Codex IDE Extension 功能](https://developers.openai.com/codex/ide/features) — 官方插件现有功能
- [Codex Changelog](https://developers.openai.com/codex/changelog/) — 官方更新日志
- [GitHub Issue #5082](https://github.com/openai/codex/issues/5082) — Undo 按钮 stage git 的 bug
- [OpenAI 社区讨论](https://community.openai.com/t/cant-see-or-undo-code-edits-with-new-gpt-5-codex-with-vscode-plugin/1358631) — 用户看不到/无法撤销代码修改
- Codex rollout.jsonl 位置：`~/Library/Application Support/codex/rollouts/`（macOS）

---

*下次继续时，从"问题 4：文件过滤策略"开始讨论。*
