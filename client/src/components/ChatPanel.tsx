import { useState, useRef, useEffect, useCallback } from "react";
import type {
  ChatMessage,
  FlickcliEvent,
  ChatMode,
  WakeLockSentinel,
} from "@/lib/types";
import { APPROVAL_MODES, CHAT_MODES, BASE_PATH } from "@/lib/types";
import type { ModelInfo } from "@/lib/types";
import { ToolCallCard } from "./ToolCallCard";

// suppress unused warning
void (null as unknown as WakeLockSentinel);

export interface AdvancedOpts {
  planModel: string;
  smallModel: string;
  visionModel: string;
  systemPrompt: string;
  appendSystemPrompt: string;
  language: string;
  browser: boolean;
  thinkingLevel: string;
  // 推送通知配置
  notificationEnabled: boolean;
  notificationRobotKey: string;
}

interface ChatPanelProps {
  selectedProject: string;
  initialSessionId: string | null;
  model: string;
  approvalMode: string;
  chatMode: ChatMode;
  advancedOpts: AdvancedOpts;
  availableModels: ModelInfo[];
  onModelChange: (m: string) => void;
  onApprovalModeChange: (m: string) => void;
  onChatModeChange: (m: ChatMode) => void;
  onAdvancedOptsChange: (opts: Partial<AdvancedOpts>) => void;
  onSessionCreated: (id: string) => void;
  onToggleSidebar?: () => void;
  onBackToTasks?: () => void;
}

export function ChatPanel({
  selectedProject,
  initialSessionId,
  model,
  approvalMode,
  chatMode,
  advancedOpts,
  availableModels,
  onModelChange,
  onApprovalModeChange,
  onChatModeChange,
  onAdvancedOptsChange,
  onSessionCreated,
  onToggleSidebar,
  onBackToTasks,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(
    initialSessionId
  );
  const [sessionInfo, setSessionInfo] = useState<{
    model?: string;
    tools?: string[];
    cwd?: string;
  }>({});
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const lastOutputIndexRef = useRef(0); // 记录已处理的输出索引

  // 持久化 currentTaskId 到 sessionStorage，刷新后可恢复
  const persistTaskId = useCallback((taskId: string | null) => {
    setCurrentTaskId(taskId);
    if (taskId) {
      sessionStorage.setItem("kwaicli_currentTaskId", taskId);
    } else {
      sessionStorage.removeItem("kwaicli_currentTaskId");
    }
  }, []);

  const hasAdvancedOpts =
    !!advancedOpts.planModel ||
    !!advancedOpts.smallModel ||
    !!advancedOpts.visionModel ||
    !!advancedOpts.systemPrompt ||
    !!advancedOpts.appendSystemPrompt ||
    !!advancedOpts.language ||
    advancedOpts.browser ||
    advancedOpts.notificationEnabled ||
    (!!advancedOpts.thinkingLevel && advancedOpts.thinkingLevel !== "off");

  // 停止轮询
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // suppress unused warning for abortControllerRef
  void abortControllerRef;

  // 启动轮询
  const startPolling = useCallback((taskId: string) => {
    console.log(`[ChatPanel] startPolling called for task: ${taskId}`);
    
    // 清除之前的轮询
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    const pendingToolCalls: Map<
      string,
      { name: string; input: Record<string, unknown> }
    > = new Map();

    const pollTask = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/task/${taskId}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        const { status, output, error } = data;

        console.log(`[Poll] Task ${taskId}: ${status}, ${output.length} events`);

        // 处理新的输出事件（增量更新）
        const newEvents = output.slice(lastOutputIndexRef.current);
        lastOutputIndexRef.current = output.length;

        for (const event of newEvents) {
          processEvent(
            event,
            setMessages,
            (id) => {
              setSessionId(id);
              onSessionCreated(id);
            },
            setSessionInfo,
            pendingToolCalls
          );
        }

        // 任务完成、失败或被取消
        if (status === "completed") {
          console.log(`[Poll] Task completed: ${taskId}`);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setIsLoading(false);
          persistTaskId(null);
        } else if (status === "failed") {
          console.error(`[Poll] Task failed: ${taskId}`, error);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: "assistant",
              content: `❌ 任务失败: ${error || "未知错误"}`,
              timestamp: new Date().toISOString(),
            },
          ]);
          setIsLoading(false);
          persistTaskId(null);
        } else if (status === "cancelled" || status === "cancelling") {
          console.log(`[Poll] Task cancelled: ${taskId}`);
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `cancelled-${Date.now()}`,
              role: "assistant",
              content: "⏹ 任务已取消",
              timestamp: new Date().toISOString(),
            },
          ]);
          setIsLoading(false);
          persistTaskId(null);
        }
      } catch (err) {
        console.error("[Poll] Error:", err);
        // 轮询错误不停止，继续重试
      }
    };

    // 立即执行一次
    pollTask();

    // 每秒轮询一次
    pollIntervalRef.current = setInterval(pollTask, 1000);
  }, [onSessionCreated, persistTaskId]);

  useEffect(() => {
    if (!showModelPicker) return;
    const handler = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showModelPicker]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 用 ref 保存 startPolling 最新引用，避免 useEffect 因其变化而重复触发
  const startPollingRef = useRef(startPolling);
  startPollingRef.current = startPolling;

  // 历史加载 — 仅在 session/project 变化时触发
  useEffect(() => {
    if (!initialSessionId || !selectedProject) return;
    
    setLoadingHistory(true);
    console.log(`[ChatPanel] Loading history: session=${initialSessionId}, project=${selectedProject}`);
    
    fetch(
      `${BASE_PATH}/api/sessions/history?project=${encodeURIComponent(selectedProject)}&session=${initialSessionId}`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.events && data.events.length > 0) {
          const restored = buildMessagesFromHistory(data.events);
          setMessages(restored);
        }
      })
      .catch(console.error)
      .finally(() => setLoadingHistory(false));
  }, [initialSessionId, selectedProject]);

  // 任务恢复 — 页面加载时检测是否有未完成的任务（独立 effect，只跑一次）
  const taskRecoveryRan = useRef(false);
  useEffect(() => {
    if (taskRecoveryRan.current) return;
    if (!selectedProject) return;
    taskRecoveryRan.current = true;

    console.log(`[TaskRecovery] Starting recovery check, session=${initialSessionId}, project=${selectedProject}`);

    // 恢复函数
    function resumeTask(taskId: string, source: string) {
      console.log(`[TaskRecovery] Resuming task ${taskId} (from ${source})`);
      setIsLoading(true);
      persistTaskId(taskId);
      lastOutputIndexRef.current = 0;
      startPollingRef.current(taskId);
    }

    // 1. 优先从 sessionStorage 恢复
    const savedTaskId = sessionStorage.getItem("kwaicli_currentTaskId");
    if (savedTaskId) {
      console.log(`[TaskRecovery] Found saved taskId in sessionStorage: ${savedTaskId}`);
      fetch(`${BASE_PATH}/api/task/${savedTaskId}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.status === "pending" || data.status === "running") {
            resumeTask(savedTaskId, "sessionStorage");
          } else {
            console.log(`[TaskRecovery] Saved task ${savedTaskId} is ${data.status}, clearing`);
            persistTaskId(null);
            checkSessionTasks();
          }
        })
        .catch(() => {
          console.warn(`[TaskRecovery] Failed to fetch saved task ${savedTaskId}, falling back`);
          persistTaskId(null);
          checkSessionTasks();
        });
      return;
    }

    // 2. 没有 sessionStorage，检查服务端是否有该 session 的活跃任务
    checkSessionTasks();

    function checkSessionTasks() {
      const sid = initialSessionId;
      if (!sid) {
        console.log(`[TaskRecovery] No sessionId, skipping server check`);
        return;
      }
      console.log(`[TaskRecovery] Checking server for active tasks in session ${sid}`);
      fetch(`${BASE_PATH}/api/tasks?sessionId=${sid}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.tasks && data.tasks.length > 0) {
            const runningTask = data.tasks.find((task: { sessionId: string; status: string }) => 
              task.sessionId === sid && 
              (task.status === "pending" || task.status === "running")
            );
            if (runningTask) {
              resumeTask(runningTask.id, "server-query");
            } else {
              console.log(`[TaskRecovery] No active tasks found for session ${sid}`);
            }
          }
        })
        .catch((err) => {
          console.error("[TaskRecovery] Failed to check session tasks:", err);
        });
    }
  }, [initialSessionId, selectedProject, persistTaskId]);


  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    // 双重检查：确保该 session 没有正在执行的任务
    if (sessionId) {
      try {
        const checkRes = await fetch(`${BASE_PATH}/api/tasks?sessionId=${sessionId}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          const hasRunningTask = checkData.tasks?.some((task: { status: string }) =>
            task.status === "pending" || task.status === "running"
          );
          if (hasRunningTask) {
            console.warn("[handleSubmit] Session already has running task, blocking new submission");
            alert("该会话已有任务正在执行中，请等待完成后再发送新消息");
            return;
          }
        }
      } catch (err) {
        console.error("[handleSubmit] Failed to check running tasks:", err);
        // 检查失败时继续，不阻止用户操作
      }
    }

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    lastOutputIndexRef.current = 0; // 重置输出索引

    try {
      // 1. 创建任务
      const res = await fetch(`${BASE_PATH}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          sessionId: sessionId || undefined,
          cwd: selectedProject || undefined,
          model: model || undefined,
          planModel: advancedOpts.planModel || undefined,
          smallModel: advancedOpts.smallModel || undefined,
          visionModel: advancedOpts.visionModel || undefined,
          approvalMode:
            approvalMode !== "default" ? approvalMode : undefined,
          systemPrompt: advancedOpts.systemPrompt || undefined,
          appendSystemPrompt: advancedOpts.appendSystemPrompt || undefined,
          language: advancedOpts.language || undefined,
          browser: advancedOpts.browser || undefined,
          thinkingLevel: advancedOpts.thinkingLevel && advancedOpts.thinkingLevel !== "off"
            ? advancedOpts.thinkingLevel
            : undefined,
          chatMode: chatMode !== "agent" ? chatMode : undefined,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // 409: 该 session 已有活跃任务，自动恢复轮询
        if (res.status === 409 && errData.activeTaskId) {
          console.log(`[handleSubmit] Session has active task: ${errData.activeTaskId}, resuming polling`);
          setIsLoading(true);
          persistTaskId(errData.activeTaskId);
          lastOutputIndexRef.current = 0;
          startPolling(errData.activeTaskId);
          // 移除刚添加的用户消息
          setMessages((prev) => prev.filter((m) => m.id !== userMsg.id));
          return;
        }
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const taskId = data.taskId;

      if (!taskId) {
        throw new Error("No task ID returned");
      }

      // 更新 sessionId（如果是新会话）
      if (data.sessionId && !sessionId) {
        setSessionId(data.sessionId);
        onSessionCreated(data.sessionId);
      }

      persistTaskId(taskId);
      console.log(`[Task] Created: ${taskId}`);

      // 2. 开始轮询任务状态
      startPolling(taskId);
    } catch (error) {
      console.error("[handleSubmit] Error:", error);
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: "assistant",
          content: `❌ 错误: ${error instanceof Error ? error.message : "未知错误"}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      setIsLoading(false);
    }
  };

  // 组件卸载时停止轮询
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const handleCancel = async () => {
    if (!currentTaskId) {
      stopPolling();
      setIsLoading(false);
      persistTaskId(null);
      return;
    }

    try {
      const res = await fetch(`${BASE_PATH}/api/task/${currentTaskId}/cancel`, {
        method: "POST",
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`[Cancel] Task ${currentTaskId}: ${data.status}`);
        
        stopPolling();
        setIsLoading(false);
        persistTaskId(null);

        setMessages((prev) => [
          ...prev,
          {
            id: `cancel-${Date.now()}`,
            role: "assistant",
            content: "⏹ 任务已停止",
            timestamp: new Date().toISOString(),
          },
        ]);
      } else {
        const data = await res.json();
        console.error(`[Cancel] Failed to cancel task:`, data);
        
        stopPolling();
        setIsLoading(false);
        persistTaskId(null);

        setMessages((prev) => [
          ...prev,
          {
            id: `cancel-err-${Date.now()}`,
            role: "assistant",
            content: `⚠️ 停止失败: ${data.error || "未知错误"}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    } catch (error) {
      console.error("[Cancel] Error:", error);
      
      stopPolling();
      setIsLoading(false);
      persistTaskId(null);

      setMessages((prev) => [
        ...prev,
        {
          id: `cancel-err-${Date.now()}`,
          role: "assistant",
          content: `❌ 停止错误: ${error instanceof Error ? error.message : "未知错误"}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    }
  };

  const handleKeyDown = (_e: React.KeyboardEvent) => {
    // Enter = 换行（默认行为），不发送
  };

  const projectName = selectedProject.split("/").pop() || "";
  const currentModel =
    availableModels.find((m) => m.id === model) || { id: model, label: model, group: "Other" };
  const currentMode =
    APPROVAL_MODES.find((m) => m.id === approvalMode) || APPROVAL_MODES[0];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header — shrink-0 keeps it visible */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 shrink-0">
        {/* Row 1: Project info + hamburger */}
        <div className="flex items-center justify-between px-3 py-2 md:px-4 md:py-2.5">
          <div className="flex items-center gap-2 min-w-0">
            {/* Back to Tasks button */}
            {onBackToTasks && (
              <button
                onClick={onBackToTasks}
                className="text-zinc-400 hover:text-zinc-100 text-sm p-2 -ml-1 hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-1"
                title="返回任务列表"
              >
                ← <span className="hidden sm:inline">任务列表</span>
              </button>
            )}
            {/* Mobile hamburger */}
            {onToggleSidebar && !onBackToTasks && (
              <button
                onClick={onToggleSidebar}
                className="md:hidden text-zinc-100 hover:text-white text-xl p-2 -ml-1 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                ☰
              </button>
            )}
            {selectedProject && (
              <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/30 text-emerald-400 font-mono truncate max-w-[120px] md:max-w-40">
                📂 {projectName}
              </span>
            )}
            {sessionId && (
              <span className="hidden sm:inline text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">
                {sessionId}
              </span>
            )}
            {sessionInfo.model && (
              <span className="hidden md:inline text-[10px] px-1.5 py-0.5 rounded bg-indigo-900/30 text-indigo-400">
                {sessionInfo.model}
              </span>
            )}
          </div>

          {/* Model + Mode Controls */}
          <div className="flex items-center gap-1 md:gap-2 shrink-0 flex-wrap justify-end">
            {/* Model Picker */}
            <div className="relative" ref={modelPickerRef}>
              <button
                onClick={() => setShowModelPicker(!showModelPicker)}
                className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors flex items-center gap-1"
              >
                <span className="hidden sm:inline">🤖</span> {currentModel.label}
                <span className="text-zinc-600 text-[10px]">▼</span>
              </button>
              {showModelPicker && (
                <div className="absolute right-0 top-full mt-1 w-56 md:w-64 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl z-50 py-1 max-h-80 overflow-y-auto thin-scrollbar">
                  {(["KAT", "Claude", "Gemini", "GPT", "Other"] as const).map((group) => {
                    const models = availableModels.filter((m) => m.group === group);
                    if (models.length === 0) return null;
                    return (
                      <div key={group}>
                        <div className="px-3 py-1 text-[10px] text-zinc-500 font-semibold uppercase tracking-wider border-t border-zinc-700/50 first:border-t-0 mt-1 first:mt-0">
                          {group}
                        </div>
                        {models.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => {
                              onModelChange(m.id);
                              setShowModelPicker(false);
                            }}
                            className={`w-full text-left px-3 py-2 md:py-1.5 text-xs hover:bg-zinc-700 transition-colors ${
                              model === m.id
                                ? "text-blue-400 bg-zinc-700/30"
                                : "text-zinc-300"
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{m.label}</span>
                              {model === m.id && <span className="text-blue-400 text-[10px]">●</span>}
                            </div>
                            <div className="text-zinc-500 text-[10px]">{m.desc}</div>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Chat Mode Selector */}
            <div className="flex rounded-lg overflow-hidden border border-zinc-700">
              {CHAT_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onChatModeChange(m.id)}
                  className={`text-[11px] md:text-xs px-1.5 md:px-2 py-1 transition-colors ${
                    chatMode === m.id
                      ? m.id === "agent"
                        ? "bg-emerald-900/50 text-emerald-300"
                        : m.id === "plan"
                        ? "bg-purple-900/50 text-purple-300"
                        : "bg-sky-900/50 text-sky-300"
                      : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-300"
                  }`}
                  title={m.desc}
                >
                  {m.icon}<span className="hidden sm:inline"> {m.label}</span>
                </button>
              ))}
            </div>

            {/* Thinking indicator — 显式设置或 Claude 默认 high */}
            {(() => {
              const explicit = advancedOpts.thinkingLevel && advancedOpts.thinkingLevel !== "off";
              const implicitClaude = !explicit && model.toLowerCase().includes("claude");
              if (!explicit && !implicitClaude) return null;
              const level = explicit ? advancedOpts.thinkingLevel : "high";
              return (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-900/30 text-orange-400 border border-orange-800/50">
                  🧠<span className="hidden sm:inline"> {level}</span>
                </span>
              );
            })()}

            {/* Approval Mode Cycle */}
            <button
              onClick={() => {
                const idx = APPROVAL_MODES.findIndex(
                  (m) => m.id === approvalMode
                );
                const next =
                  APPROVAL_MODES[(idx + 1) % APPROVAL_MODES.length];
                onApprovalModeChange(next.id);
              }}
              className="hidden sm:block text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              title={`${currentMode.label}: ${currentMode.desc}\n点击切换`}
            >
              {currentMode.icon} {currentMode.label}
            </button>

            {/* Advanced Options Toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                showAdvanced || hasAdvancedOpts
                  ? "bg-violet-900/40 text-violet-300 hover:bg-violet-900/60"
                  : "bg-zinc-800 hover:bg-zinc-700 text-zinc-400"
              }`}
              title="高级选项"
            >
              <span className="text-[10px]">{showAdvanced ? "▲" : "▼"}</span>
              <span className="hidden sm:inline">高级</span>
              {hasAdvancedOpts && !showAdvanced && (
                <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Advanced Options Panel */}
      {showAdvanced && (
        <div className="border-b border-zinc-800 bg-zinc-900/50 px-4 py-3 shrink-0 max-h-[40vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            {/* Plan Model */}
            <div>
              <label className="text-zinc-500 block mb-1">Plan Model</label>
              <select
                value={advancedOpts.planModel}
                onChange={(e) => onAdvancedOptsChange({ planModel: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 focus:border-violet-500 focus:outline-none"
              >
                <option value="">跟随主模型</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <div className="text-zinc-600 text-[10px] mt-0.5">复杂任务规划阶段</div>
            </div>

            {/* Small Model */}
            <div>
              <label className="text-zinc-500 block mb-1">Small Model</label>
              <select
                value={advancedOpts.smallModel}
                onChange={(e) => onAdvancedOptsChange({ smallModel: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 focus:border-violet-500 focus:outline-none"
              >
                <option value="">默认</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <div className="text-zinc-600 text-[10px] mt-0.5">快速操作用</div>
            </div>

            {/* Vision Model */}
            <div>
              <label className="text-zinc-500 block mb-1">Vision Model</label>
              <select
                value={advancedOpts.visionModel}
                onChange={(e) => onAdvancedOptsChange({ visionModel: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 focus:border-violet-500 focus:outline-none"
              >
                <option value="">默认</option>
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              <div className="text-zinc-600 text-[10px] mt-0.5">图像分析用</div>
            </div>

            {/* Language */}
            <div>
              <label className="text-zinc-500 block mb-1">Language</label>
              <select
                value={advancedOpts.language}
                onChange={(e) => onAdvancedOptsChange({ language: e.target.value })}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-300 focus:border-violet-500 focus:outline-none"
              >
                <option value="">默认</option>
                <option value="Chinese">中文</option>
                <option value="English">English</option>
                <option value="Japanese">日本語</option>
              </select>
            </div>

            {/* Browser */}
            <div className="flex items-center gap-2">
              <label className="text-zinc-500">Browser</label>
              <button
                onClick={() => onAdvancedOptsChange({ browser: !advancedOpts.browser })}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  advancedOpts.browser
                    ? "bg-green-900/40 text-green-300 border border-green-700"
                    : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                }`}
              >
                {advancedOpts.browser ? "已启用" : "未启用"}
              </button>
              <div className="text-zinc-600 text-[10px]">浏览器集成</div>
            </div>

            {/* Thinking Level */}
            <div>
              <label className="text-zinc-500 block mb-1">Thinking</label>
              <div className="flex gap-1">
                {[
                  { id: "off", label: "关闭", color: "zinc" },
                  { id: "low", label: "Low", color: "blue" },
                  { id: "medium", label: "Med", color: "amber" },
                  { id: "high", label: "High", color: "orange" },
                ].map((lvl) => (
                  <button
                    key={lvl.id}
                    onClick={() => onAdvancedOptsChange({ thinkingLevel: lvl.id })}
                    className={`px-1.5 py-1 rounded text-[10px] transition-colors border ${
                      advancedOpts.thinkingLevel === lvl.id
                        ? lvl.id === "off"
                          ? "bg-zinc-700 text-zinc-200 border-zinc-500"
                          : lvl.id === "low"
                          ? "bg-blue-900/40 text-blue-300 border-blue-700"
                          : lvl.id === "medium"
                          ? "bg-amber-900/40 text-amber-300 border-amber-700"
                          : "bg-orange-900/40 text-orange-300 border-orange-700"
                        : "bg-zinc-800/50 text-zinc-500 border-zinc-700/50 hover:bg-zinc-700"
                    }`}
                  >
                    {lvl.label}
                  </button>
                ))}
              </div>
              <div className="text-zinc-600 text-[10px] mt-0.5">Claude/Gemini深度思考</div>
            </div>

            {/* Reset */}
            <div className="flex items-end">
              {hasAdvancedOpts && (
                <button
                  onClick={() =>
                    onAdvancedOptsChange({
                      planModel: "",
                      smallModel: "",
                      visionModel: "",
                      systemPrompt: "",
                      appendSystemPrompt: "",
                      language: "",
                      browser: false,
                      thinkingLevel: "off",
                      notificationEnabled: false,
                      notificationRobotKey: "",
                    })
                  }
                  className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-400 hover:bg-red-900/50 transition-colors"
                >
                  重置全部
                </button>
              )}
            </div>

            {/* 推送通知 */}
            <div className="col-span-1 sm:col-span-2">
              <div className="flex items-center gap-3 mb-2">
                <label className="text-zinc-500 text-xs">任务完成推送</label>
                <button
                  onClick={() => onAdvancedOptsChange({ notificationEnabled: !advancedOpts.notificationEnabled })}
                  className={`px-3 py-1 rounded text-xs transition-colors border ${
                    advancedOpts.notificationEnabled
                      ? "bg-green-900/40 text-green-300 border-green-700"
                      : "bg-zinc-800 text-zinc-400 border-zinc-700"
                  }`}
                >
                  {advancedOpts.notificationEnabled ? "✓ 已启用" : "未启用"}
                </button>
              </div>
              {advancedOpts.notificationEnabled && (
                <div>
                  <input
                    type="text"
                    value={advancedOpts.notificationRobotKey}
                    onChange={(e) => onAdvancedOptsChange({ notificationRobotKey: e.target.value })}
                    placeholder="输入 KIM 机器人 RobotKey"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-300 placeholder-zinc-500 focus:border-green-500 focus:outline-none"
                  />
                  <div className="text-zinc-600 text-[10px] mt-1">
                    任务完成后将发送 KIM 通知到指定群组
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* System Prompt */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-zinc-500 text-xs block mb-1">System Prompt</label>
              <textarea
                value={advancedOpts.systemPrompt}
                onChange={(e) => onAdvancedOptsChange({ systemPrompt: e.target.value })}
                placeholder="自定义系统提示（覆盖默认）"
                rows={2}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none resize-none"
              />
            </div>
            <div>
              <label className="text-zinc-500 text-xs block mb-1">Append System Prompt</label>
              <textarea
                value={advancedOpts.appendSystemPrompt}
                onChange={(e) => onAdvancedOptsChange({ appendSystemPrompt: e.target.value })}
                placeholder="追加系统提示（不覆盖默认）"
                rows={2}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 focus:border-violet-500 focus:outline-none resize-none"
              />
            </div>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 sm:space-y-4">
        {loadingHistory && (
          <div className="flex items-center justify-center py-8 text-zinc-500 text-sm">
            <div className="flex gap-1 mr-2">
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            加载历史记录...
          </div>
        )}
        {!loadingHistory && messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-500">
            <div className="text-center space-y-3">
              <p className="text-4xl">🦞</p>
              <p className="text-lg">KwaiCLI Agent</p>
              {selectedProject ? (
                <p className="text-sm text-zinc-600">
                  当前项目: <span className="text-zinc-400">{projectName}</span>
                  <br />
                  {initialSessionId
                    ? `恢复会话 ${initialSessionId}，输入消息继续对话`
                    : "输入消息开始新对话"}
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-600">
                    请先选择一个工程目录
                  </p>
                  {onToggleSidebar && (
                    <button
                      onClick={onToggleSidebar}
                      className="md:hidden px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-medium text-base transition-colors"
                    >
                      📂 选择项目
                    </button>
                  )}
                  <p className="hidden md:block text-sm text-zinc-600">
                    ← 在侧边栏选择
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            {chatMode === "plan" ? "正在分析规划..." : chatMode === "ask" ? "正在头脑风暴..." : ((advancedOpts.thinkingLevel && advancedOpts.thinkingLevel !== "off") || model.toLowerCase().includes("claude")) ? "深度思考中..." : "正在思考..."}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input — shrink-0 + safe-area keeps it pinned at bottom */}
      <div className="p-2 sm:p-4 border-t border-zinc-800 safe-area-bottom shrink-0">
        <div className="flex gap-2 items-end">
          <div className="flex-1 flex flex-col gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 200) + "px";
              }}
              onKeyDown={handleKeyDown}
              placeholder={
                selectedProject
                  ? chatMode === "plan"
                    ? "📋 计划模式..."
                    : chatMode === "ask"
                    ? "💬 问答模式..."
                    : "输入消息..."
                  : "请先选择工程目录"
              }
              rows={2}
              className="bg-zinc-800 rounded-lg px-3 py-2 sm:px-4 sm:py-3 text-sm sm:text-base text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500/50"
              style={{ minHeight: "44px", maxHeight: "200px" }}
              disabled={isLoading || !selectedProject}
            />
          </div>

          {isLoading ? (
            <button
              type="button"
              onClick={handleCancel}
              className="px-3 py-2 sm:px-4 sm:py-3 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition-colors shrink-0"
            >
              ⏹
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={!input.trim() || !selectedProject}
              className="px-3 py-2 sm:px-4 sm:py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium transition-colors shrink-0"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  const [cmdExpanded, setCmdExpanded] = useState(false);

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[95%] sm:max-w-[85%] md:max-w-[80%] rounded-lg px-3 py-2 sm:px-4 sm:py-3 ${
          isUser
            ? "bg-blue-600 text-white"
            : message.role === "tool"
              ? "bg-zinc-800/50 border border-zinc-700"
              : "bg-zinc-800 text-zinc-100"
        }`}
      >
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-2 mb-2">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
        {message.content && (
          <div className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </div>
        )}
        {message.tokens && (
          <div className="text-xs text-zinc-500 mt-1">
            tokens: {message.tokens.input}→{message.tokens.output}
          </div>
        )}
      </div>
      {isUser && message.command && (
        <div className="max-w-[95%] sm:max-w-[85%] md:max-w-[80%] mt-1">
          <button
            onClick={() => setCmdExpanded((v) => !v)}
            className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors font-mono flex items-center gap-1"
          >
            <span className="text-zinc-700">{cmdExpanded ? "▼" : "▶"}</span>
            <span>$ flickcli ...</span>
          </button>
          {cmdExpanded && (
            <pre className="mt-1 text-[11px] text-zinc-500 bg-zinc-900/80 border border-zinc-800 rounded px-3 py-2 font-mono whitespace-pre-wrap break-all select-all">
              {message.command}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function processEvent(
  event: FlickcliEvent,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  onSession: (id: string) => void,
  setSessionInfo: React.Dispatch<
    React.SetStateAction<{ model?: string; tools?: string[]; cwd?: string }>
  >,
  pendingToolCalls: Map<
    string,
    { name: string; input: Record<string, unknown> }
  >
) {
  if (event.type === "meta" && "command" in event) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "user") {
        const updated = [...prev];
        updated[updated.length - 1] = { ...last, command: event.command };
        return updated;
      }
      return prev;
    });
    return;
  }

  if (event.type === "system" && "subtype" in event) {
    onSession(event.sessionId);
    setSessionInfo({
      model: event.model,
      tools: event.tools,
      cwd: event.cwd,
    });
    return;
  }

  if (event.type === "message" && event.role === "assistant") {
    const toolCalls: ChatMessage["toolCalls"] = [];
    let textContent = "";

    for (const item of event.content) {
      if ("type" in item && item.type === "text" && "text" in item) {
        textContent = item.text as string;
      } else if ("type" in item && item.type === "tool_use") {
        const tu = item as {
          id: string;
          name: string;
          input: Record<string, unknown>;
        };
        pendingToolCalls.set(tu.id, { name: tu.name, input: tu.input });
        toolCalls.push({
          id: tu.id,
          name: tu.name,
          input: tu.input,
        });
      }
    }

    if (textContent || toolCalls.length > 0) {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === event.uuid);
        const newMsg: ChatMessage = {
          id: event.uuid,
          role: "assistant",
          content: textContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: event.timestamp,
          tokens: event.usage
            ? { input: event.usage.input_tokens, output: event.usage.output_tokens }
            : undefined,
        };
        if (idx >= 0) {
          const existing = prev[idx];
          const merged: ChatMessage = {
            ...existing,
            content: textContent || existing.content,
            toolCalls: toolCalls.length > 0
              ? [...(existing.toolCalls || []), ...toolCalls]
              : existing.toolCalls,
            tokens: newMsg.tokens || existing.tokens,
          };
          const updated = [...prev];
          updated[idx] = merged;
          return updated;
        }
        return [...prev, newMsg];
      });
    }
    return;
  }

  if (event.type === "message" && event.role === "tool") {
    for (const item of event.content) {
      if ("type" in item && item.type === "tool-result") {
        const tr = item as {
          toolCallId: string;
          toolName: string;
          result: { returnDisplay: string; llmContent: string };
        };
        setMessages((prev) =>
          prev.map((msg) => {
            if (!msg.toolCalls) return msg;
            const updated = msg.toolCalls.map((tc) =>
              tc.id === tr.toolCallId
                ? { ...tc, result: tr.result.returnDisplay }
                : tc
            );
            return { ...msg, toolCalls: updated };
          })
        );
      }
    }
  }
}

interface HistoryEvent {
  type: string;
  role?: string;
  uuid?: string;
  content: string | Array<Record<string, unknown>>;
  text?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  timestamp?: string;
  sessionId?: string;
}

function buildMessagesFromHistory(
  events: HistoryEvent[]
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const toolCallMap = new Map<
    string,
    { msgIndex: number; tcIndex: number }
  >();

  for (const evt of events) {
    if (evt.type !== "message") continue;

    if (evt.role === "user") {
      const content =
        typeof evt.content === "string"
          ? evt.content
          : evt.text || "";
      messages.push({
        id: evt.uuid || `user-${messages.length}`,
        role: "user",
        content,
        timestamp: evt.timestamp || "",
      });
      continue;
    }

    if (evt.role === "assistant") {
      // 处理 content 为数组的情况（包含 tool_use）
      if (Array.isArray(evt.content)) {
        const toolCalls: ChatMessage["toolCalls"] = [];
        let textContent = "";

        for (const item of evt.content) {
          if (item.type === "text" && typeof item.text === "string") {
            textContent = item.text;
          } else if (item.type === "tool_use") {
            const tc = {
              id: item.id as string,
              name: item.name as string,
              input: (item.input as Record<string, unknown>) || {},
            };
            toolCalls.push(tc);
            toolCallMap.set(tc.id, {
              msgIndex: messages.length,
              tcIndex: toolCalls.length - 1,
            });
          }
        }

        if (textContent || toolCalls.length > 0) {
          messages.push({
            id: evt.uuid || `ast-${messages.length}`,
            role: "assistant",
            content: textContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            timestamp: evt.timestamp || "",
            tokens: evt.usage
              ? {
                  input: evt.usage.input_tokens,
                  output: evt.usage.output_tokens,
                }
              : undefined,
          });
        }
      } 
      // 处理 content 为字符串的情况（纯文本回复）
      else if (typeof evt.content === "string") {
        const textContent = evt.content || evt.text || "";
        if (textContent) {
          messages.push({
            id: evt.uuid || `ast-${messages.length}`,
            role: "assistant",
            content: textContent,
            timestamp: evt.timestamp || "",
            tokens: evt.usage
              ? {
                  input: evt.usage.input_tokens,
                  output: evt.usage.output_tokens,
                }
              : undefined,
          });
        }
      }
      continue;
    }

    if (evt.role === "tool" && Array.isArray(evt.content)) {
      for (const item of evt.content) {
        if (item.type === "tool-result") {
          const toolCallId = item.toolCallId as string;
          const result = item.result as {
            returnDisplay?: string;
            llmContent?: string;
          };
          const loc = toolCallMap.get(toolCallId);
          if (loc && messages[loc.msgIndex]?.toolCalls?.[loc.tcIndex]) {
            messages[loc.msgIndex].toolCalls![loc.tcIndex].result =
              result?.returnDisplay || result?.llmContent || "";
          }
        }
      }
    }
  }

  return messages;
}
