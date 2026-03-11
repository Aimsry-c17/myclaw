export interface FlickcliInitEvent {
  type: "system";
  subtype: "init";
  sessionId: string;
  model: string;
  cwd: string;
  tools: string[];
}

export interface FlickcliToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface FlickcliToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: {
    returnDisplay: string;
    llmContent: string;
    truncated: boolean;
  };
}

export interface FlickcliMessageEvent {
  type: "message";
  role: "assistant" | "tool";
  uuid: string;
  parentUuid: string;
  content: Array<
    | { type: string; text?: string }
    | FlickcliToolUse
    | FlickcliToolResult
  >;
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  timestamp: string;
  sessionId: string;
}

export interface FlickcliResultEvent {
  type: "result";
  subtype: "success" | "error";
  isError: boolean;
  content: string;
  sessionId: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface FlickcliMetaEvent {
  type: "meta";
  command: string;
  configCommand?: string;
}

export type FlickcliEvent =
  | FlickcliInitEvent
  | FlickcliMessageEvent
  | FlickcliResultEvent
  | FlickcliMetaEvent;

export interface SessionMeta {
  id: string;
  updatedAt: string;
  isSubAgent: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
  }>;
  timestamp: string;
  tokens?: { input: number; output: number };
  command?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  desc?: string;
  group: string;
}

// Fallback 模型列表（对应 CLI v0.3.2 /model 输出），仅在 API 获取失败时使用
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "kat-coder", label: "KAT-Coder", desc: "编程专用", group: "KAT" },
  { id: "claude-4.6-sonnet", label: "Claude 4.6 Sonnet", desc: "最新旗舰", group: "Claude" },
  { id: "claude-4.5-sonnet", label: "Claude 4.5 Sonnet", desc: "预览版", group: "Claude" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5", desc: "快速轻量", group: "Claude" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", desc: "最新Gemini", group: "Gemini" },
  { id: "gpt-5.2", label: "GPT-5.2", desc: "最新GPT", group: "GPT" },
  { id: "gpt-5.1-codex-max", label: "GPT 5.1 Codex Max", desc: "代码推理", group: "GPT" },
  { id: "gpt-5", label: "GPT-5", desc: "通用智能", group: "GPT" },
  { id: "minimax-m2.5", label: "MiniMax M2.5", desc: "最新MiniMax", group: "Other" },
  { id: "kimi-k2.5", label: "Kimi K2.5", desc: "Moonshot推理", group: "Other" },
  { id: "glm-5", label: "GLM-5", desc: "最新GLM", group: "Other" },
  { id: "glm-4.7", label: "GLM-4.7", desc: "快速经济", group: "Other" },
  { id: "glm-4.6", label: "GLM-4.6", desc: "经济实惠", group: "Other" },
  { id: "minimax-m2.1", label: "MiniMax M2.1", desc: "指导助手", group: "Other" },
];

export const APPROVAL_MODES = [
  { id: "default", label: "安全模式", icon: "🛡️", desc: "操作需确认" },
  { id: "autoEdit", label: "自动编辑", icon: "✏️", desc: "编辑自动，bash需确认" },
  { id: "yolo", label: "YOLO", icon: "🚀", desc: "全部自动执行" },
] as const;

export type ChatMode = "agent" | "plan" | "ask";

export const CHAT_MODES = [
  { id: "agent" as ChatMode, label: "智能体", icon: "∞", desc: "完整能力，可读写编辑执行" },
  { id: "plan" as ChatMode, label: "计划", icon: "☰", desc: "只读分析，输出实现计划" },
  { id: "ask" as ChatMode, label: "问答", icon: "💬", desc: "头脑风暴，纯对话不改代码" },
] as const;

export function isClaudeModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("claude");
}

export function isGeminiModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("gemini");
}

export const BASE_PATH = process.env.BASE_PATH || "";

// Wake Lock API types for mobile screen keep-alive
export interface WakeLockSentinel extends EventTarget {
  readonly released: boolean;
  readonly type: "screen";
  release(): Promise<void>;
}

export interface WakeLock {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

// ============================================
// Task Management Types
// ============================================

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelling" | "cancelled";

export interface ProcessInfo {
  type: "local" | "remote";
  pid?: number;
  sshConnId?: string;
  killable: boolean;
}

export interface Task {
  id: string;
  sessionId: string | null;  // CLI 的真实 session ID，创建时可能为 null
  project: string;
  message: string;
  model?: string;
  status: TaskStatus;
  output: FlickcliEvent[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  // 额外参数
  approvalMode?: string;
  chatMode?: ChatMode;
  advancedOpts?: Record<string, unknown>;
  // 进程信息和取消支持
  processInfo?: ProcessInfo;
  cancellationRequested?: boolean;
}

export interface TaskQueueState {
  queue: string[];  // 待执行任务 ID 列表
  running: string[];  // 正在执行的任务 ID 列表
}
