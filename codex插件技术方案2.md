# Codex Companion — 项目讨论记录与技术决策汇总

> 最后更新：2026-03-18
> 状态：技术选型讨论中（尚未开始编码）

---

## 一、项目背景与动机

### 1.1 起因

OpenAI Codex 发布了桌面应用，可以跟 AI 对话生成/修改代码，但存在以下痛点：
- 只能点击预览代码，**不能逐块确认哪些代码要、哪些不要**
- 不能看到整个项目目录
- 缺少像 Cursor 那样的 AI IDE 的代码审查能力

最初想法：**做一个类似 Cursor 的 IDE 来增强 Codex**。

### 1.2 关键发现

经过调研发现：
- **Codex CLI + App Server** 是开源的（Apache-2.0），代码在 `github.com/openai/codex`
- **Codex App（桌面端 GUI）** 不开源，无法直接修改
- **Codex IDE Extension（VS Code 插件）** 也不开源，无法提 PR

### 1.3 方向转变

从"做一个独立 Electron IDE" → 转为 **"做一个 VS Code 伴侣扩展"**

理由：
- VS Code 扩展开发门槛低（TypeScript + Node.js）
- 不需要自己造编辑器、文件树等基础组件
- 可以和 Codex 官方插件共存，互不干扰
- Codex VS Code 插件仍在积极维护，官方同时维护 App + CLI + IDE Extension

---

## 二、项目定位

**项目名**：`codex-companion`

**类型**：独立的 VS Code 扩展（第三方，非官方）

**定位**：Codex 官方 VS Code 插件的"伴侣扩展"，提供官方缺失的代码审查和变更管理能力

**使用方式**：用户同时安装 Codex 官方插件 + Codex Companion，两者独立运行

---

## 三、四大核心功能

### 功能 1：Diff 预览 + 逐块 Accept/Reject ⭐核心卖点

**解决的问题**：Codex 改完代码后，用户只能整体接受或撤销，无法选择性地接受某些修改、拒绝某些修改。

**做什么**：
- 监控文件变化，检测到 AI 修改后自动弹出 VS Code Diff 视图
- 左侧显示"修改前"，右侧显示"修改后"
- 提供 Accept All / Reject All 按钮
- Phase 2 支持 Hunk 级别的逐块 Accept/Reject

### 功能 2：Checkpoint 快照回滚

**解决的问题**：Codex 的 Undo 按钮有 bug（会自动 git stage），用户无法安全地撤销 AI 的修改。

**做什么**：
- 每次 AI 修改代码前，自动保存一个"快照"（记录所有受影响文件的原始内容）
- 用户不满意时，点"回滚"一键恢复到任意快照点
- 完全不碰 git，不影响用户的 staging area
- 类似游戏的"存档点"

### 功能 3：变更摘要面板

**解决的问题**：Codex 新版改完代码后，用户看不到改了哪些文件、每个文件改了什么。

**做什么**：
- 侧边栏 TreeView 展示变更列表
- 每个 Checkpoint 是一个节点，展开显示涉及的文件
- 每个文件旁标注变更类型（修改/新增/删除）和增减行数
- 点击文件直接打开 Diff 视图

### 功能 4：会话历史持久化

**解决的问题**：Codex 对话历史在重启 VS Code 后消失，无法导出保存。

**做什么**：
- 解析 Codex 本地存储的 `rollout.jsonl` 文件
- 提供 WebView 面板浏览和搜索历史对话
- 支持导出为 Markdown 文件

---

## 四、技术架构

### 4.1 集成方式

**已确定：改进版方式 A（文件系统监听 + 内存快照）**

讨论过两种方式：

| | 方式 A：文件系统监听 | 方式 B：直连 App Server |
|--|---------|---------|
| 原理 | FileSystemWatcher 监控文件变化 | 通过 JSON-RPC 2.0 连接 Codex App Server |
| 优点 | 与官方插件完全解耦，不怕更新 | 精确感知 AI 事件，可在写入前拦截 |
| 缺点 | 事后察觉，需要解决"原始内容"获取问题 | 可能与官方插件冲突，实现复杂 |
| **结论** | ✅ **选择此方案** | 留作未来升级路径 |

**关键改进**：不用 `git show HEAD` 获取原始内容（有混入用户未提交改动的风险），而是：
- 扩展启动时把工作区文件读入内存作为"基准快照"
- 每次 AI 改文件时，用内存基准对比，100% 准确
- 用户保存文件时，更新基准快照

### 4.2 系统架构图

```
用户
 │
 ├──► Codex 官方插件（聊天、发任务、AI 对话）
 │         │
 │         ▼
 │     Codex App Server（开源，JSON-RPC 2.0）
 │         │
 │         ▼
 │     文件系统（apply_patch 写入磁盘）
 │
 └──► Codex Companion 扩展（本项目）
           │
           ├── FileWatcher：监控工作区文件变化
           ├── CheckpointManager：基准快照 + 回滚
           ├── DiffViewManager：VS Code Diff Editor
           ├── CheckpointTreeProvider：侧边栏变更摘要
           └── HistoryWebView：会话历史浏览
```

---

## 五、已确定的技术选型

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 扩展主体语言 | **TypeScript** | VS Code 扩展标准语言 |
| 构建工具 | **esbuild（统一）** | 一个工具打包扩展主体 + WebView React，简单统一 |
| WebView 前端框架 | **React** | 用户选择 |
| 快照存储位置 | **`context.storageUri`** | VS Code 按工作区隔离的存储目录，不污染项目 |
| 集成方式 | **改进版方式 A** | 文件系统监听 + 内存基准快照 |

### esbuild 统一构建方案

一个 `esbuild.js` 文件同时构建两个产物：

```javascript
// 构建 1：扩展主体（Node.js 环境）
{
  entryPoints: ['src/extension.ts'],
  platform: 'node',
  external: ['vscode'],
  format: 'cjs',
  outfile: 'out/extension.js',
}

// 构建 2：WebView React 页面（浏览器环境）
{
  entryPoints: ['src/webview/App.tsx'],
  platform: 'browser',
  format: 'iife',
  outfile: 'out/webview.js',
  jsx: 'automatic',
}
```

---

## 六、尚未确定的技术选型

以下问题还需要讨论后确定：

### 问题 1：内存快照的文件过滤策略（待确认）

扩展启动时要把工作区文件读入内存，需要过滤大文件和无关文件：

- **选项 A**：读取 `.gitignore` 规则，凡是 git 忽略的就跳过
- **选项 B**：白名单，只快照常见代码文件扩展名（`.ts`、`.js`、`.py` 等）
- **选项 C**：A + B 结合，先用 `.gitignore` 过滤，再只保留文本文件

### 问题 2：包管理器（待确认）

- npm / pnpm / yarn

### 问题 3：VS Code 最低版本支持（待确认）

### 问题 4：是否兼容 Cursor / Windsurf 等 VS Code fork（待确认）

### 问题 5：批量变化检测的默认阈值（待确认）

---

## 七、项目结构

```
codex-companion/
├── package.json
├── tsconfig.json
├── esbuild.js                   # 统一构建脚本
├── src/
│   ├── extension.ts             # 入口
│   ├── checkpoint/
│   │   ├── types.ts             # Checkpoint, FileSnapshot 类型
│   │   ├── CheckpointManager.ts # 核心调度器
│   │   ├── FileWatcher.ts       # 文件监听 + 批量检测
│   │   └── SnapshotStore.ts     # 快照持久化
│   ├── diff/
│   │   ├── CheckpointContentProvider.ts  # 虚拟文档
│   │   ├── DiffViewManager.ts            # 打开 Diff Editor
│   │   └── HunkManager.ts               # Hunk 级 accept/reject
│   ├── views/
│   │   ├── CheckpointTreeProvider.ts     # 侧边栏 TreeView
│   │   └── CheckpointTreeItem.ts
│   ├── webview/
│   │   ├── App.tsx              # React 会话历史页面
│   │   └── index.html
│   ├── history/
│   │   ├── RolloutParser.ts     # 解析 rollout.jsonl
│   │   ├── HistoryManager.ts
│   │   └── HistoryExporter.ts   # 导出 Markdown
│   └── utils/
│       ├── config.ts
│       ├── logger.ts
│       └── pathUtils.ts
├── resources/icons/
├── test/
└── README.md
```

---

## 八、开发阶段规划

| 阶段 | 周期 | 目标 |
|------|------|------|
| Phase 1 | 1-2 周 | MVP：FileWatcher + Checkpoint + 基本 Diff + Accept/Reject + 侧边栏 |
| Phase 2 | 1 周 | Hunk 级逐块操作 + 单文件 Revert + 批量检测优化 |
| Phase 3 | 1 周 | 会话历史 WebView + rollout.jsonl 解析 + 导出 |
| Phase 4 | 1 周 | 打磨 + 错误处理 + README + 发布 Marketplace |

---

## 九、已识别的风险与应对

| 风险 | 应对 |
|------|------|
| 无法区分 Codex 改的 vs 用户改的 | 启发式规则 + 手动 checkpoint 命令 + 可配置阈值 |
| Codex rollout.jsonl 格式变化 | 容错处理，降级显示原始 JSON |
| 大型项目内存快照占用大 | 过滤 node_modules + 二进制文件 |
| VS Code Diff Editor 的 hunk 操作有限 | 备选：自定义 WebView Diff 视图 |
| 基准快照更新时机问题 | 监听 onDidSaveTextDocument + 手动"标记当前状态"命令 |

---

## 十、关键调研结论

### Codex 官方插件仍在维护
- 2026 年 3 月仍有更新，支持 GPT-5.4
- 支持平台在扩大（新增 JetBrains IDEs）
- GitHub Issues 持续修 bug
- 桌面端 App 和 IDE 插件是并行产品，不互相替代

### Codex 社区真实痛点
- GitHub Issue #5082：Undo 按钮错误地 stage git 变更
- 社区帖：重启后对话历史消失
- 社区帖：看不到 AI 改了什么代码
- 社区帖：无法导出对话记录

---

## 十一、下次继续的话题

从 **"问题 1：文件过滤策略"** 开始，继续确定剩余技术选型，全部确定后开始编码。
