import { useState, useEffect, useCallback, useRef } from "react";
import type { AdvancedOpts } from "./ChatPanel";
import { CHAT_MODES, BASE_PATH } from "@/lib/types";
import type { ChatMode } from "@/lib/types";

// 仅使用 CHAT_MODES 用于类型检查
void CHAT_MODES;

interface TaskItem {
  id: string;
  sessionId: string;
  project: string;
  message: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelling" | "cancelled";
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  outputLength: number;
}

interface TaskListProps {
  selectedProject: string;
  model: string;
  chatMode: ChatMode;
  advancedOpts: AdvancedOpts;
  onSelectSession: (sessionId: string, project?: string) => void;
  onSessionCreated?: (sessionId: string) => void;
  onToggleSidebar?: () => void;
}

export function TaskList({
  selectedProject,
  model,
  chatMode,
  advancedOpts,
  onSelectSession,
  onSessionCreated,
  onToggleSidebar,
}: TaskListProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const prevTasksRef = useRef<Map<string, TaskItem>>(new Map());
  // 标记是否已完成首次加载，轮询时不再显示 loading
  const initialLoadDoneRef = useRef(false);

  // 加载任务列表
  const loadTasks = useCallback(async (showLoading = false) => {
    if (showLoading) setIsLoading(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/tasks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      
      const data = await res.json();
      const newTasks = data.tasks || [];
      
      // 检查任务状态变化，触发会话列表刷新
      if (onSessionCreated) {
        newTasks.forEach((task: TaskItem) => {
          const prevTask = prevTasksRef.current.get(task.id);
          // 如果任务从非完成状态变为完成状态，触发会话刷新
          if (task.status === 'completed' && (!prevTask || prevTask.status !== 'completed')) {
            console.log('[TaskList] Task completed, refreshing session list:', task.sessionId);
            onSessionCreated(task.sessionId);
          }
        });
      }
      
      // 更新任务状态引用
      prevTasksRef.current = new Map(newTasks.map((t: TaskItem) => [t.id, t]));
      setTasks(newTasks);
    } catch (error) {
      console.error("[TaskList] Failed to load tasks:", error);
    } finally {
      if (showLoading) setIsLoading(false);
    }
  }, [onSessionCreated]);

  // 初始加载
  useEffect(() => {
    // 首次加载显示 loading，后续轮询静默刷新
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      loadTasks(true);
    } else {
      loadTasks(false);
    }
    
    // 每5秒静默刷新一次任务列表（不显示加载状态）
    const interval = setInterval(() => loadTasks(false), 5000);
    return () => clearInterval(interval);
  }, [loadTasks]);

  // 创建新任务
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isSubmitting || !selectedProject) return;

    setIsSubmitting(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          cwd: selectedProject,
          model,
          chatMode: chatMode !== "agent" ? chatMode : undefined,
          ...advancedOpts,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.taskId) {
        setInput("");
        // 立即刷新任务列表（静默，不显示 loading）
        await loadTasks(false);
      }
    } catch (error) {
      console.error("[TaskList] Failed to create task:", error);
      alert(`创建任务失败: ${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  // 点击任务进入详情页
  const handleTaskClick = (task: TaskItem) => {
    onSelectSession(task.sessionId, task.project);
  };

  // 状态显示
  const getStatusDisplay = (task: TaskItem) => {
    if (!task || !task.status) {
      return { icon: "❓", text: "未知", color: "text-zinc-400" };
    }
    
    switch (task.status) {
      case "pending":
        return { icon: "⏳", text: "等待中", color: "text-zinc-400" };
      case "running":
        return { icon: "🔄", text: "执行中", color: "text-blue-400" };
      case "completed":
        return { icon: "✅", text: "已完成", color: "text-green-400" };
      case "failed":
        return { icon: "❌", text: "失败", color: "text-red-400" };
      case "cancelling":
        return { icon: "⏸️", text: "取消中", color: "text-yellow-400" };
      case "cancelled":
        return { icon: "⏹️", text: "已取消", color: "text-zinc-500" };
      default:
        return { icon: "❓", text: "未知", color: "text-zinc-400" };
    }
  };

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    
    return date.toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="h-full flex flex-col bg-zinc-950">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/50 px-4 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {/* 移动端侧边栏按钮 */}
            {onToggleSidebar && (
              <button
                onClick={onToggleSidebar}
                className="md:hidden flex items-center gap-2 px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
                title="选择项目"
              >
                <span className="text-base">📂</span>
                <span className="text-xs font-mono">选择项目</span>
              </button>
            )}
            {/* 标题 */}
            <h1 className="text-xl font-semibold text-zinc-100">所有任务</h1>
            <span className="text-xs text-zinc-500">(每个会话仅显示最新)</span>
          </div>
          <div className="text-xs text-zinc-500">
            共 {tasks.length} 个任务
          </div>
        </div>

        {/* 快速创建任务 */}
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              selectedProject
                ? "输入任务内容，按回车创建..."
                : "请先在左侧选择项目"
            }
            disabled={isSubmitting || !selectedProject}
            className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || isSubmitting || !selectedProject}
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium transition-colors shrink-0"
          >
            {isSubmitting ? "创建中..." : "创建任务"}
          </button>
        </form>
      </div>

      {/* Task List */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-zinc-500">
            <div className="flex gap-1 mr-2">
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:0ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:150ms]" />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce [animation-delay:300ms]" />
            </div>
            加载中...
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-500">
            <div className="text-center space-y-3">
              <p className="text-4xl">📝</p>
              <p className="text-lg">暂无任务</p>
              <p className="text-sm text-zinc-600">
                {selectedProject
                  ? "输入内容创建第一个任务吧"
                  : "请先在左侧选择项目"}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {tasks.map((task) => {
              if (!task || !task.id) return null;
              
              const status = getStatusDisplay(task);
              return (
                <div
                  key={task.id}
                  onClick={() => handleTaskClick(task)}
                  className="bg-zinc-900/50 border border-zinc-800 rounded-lg p-4 hover:bg-zinc-800/50 hover:border-zinc-700 transition-all cursor-pointer group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <span className={`text-sm font-medium ${status?.color || 'text-zinc-400'}`}>
                          {status?.icon || '❓'} {status?.text || '未知'}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/30 text-emerald-400 font-mono">
                          📂 {task.project?.split('/').pop() || '未知项目'}
                        </span>
                        <span className="text-xs text-zinc-600">
                          {formatTime(task.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm text-zinc-300 line-clamp-2 group-hover:text-zinc-100 transition-colors">
                        {task.message || '无消息'}
                      </p>
                      {task.error && (
                        <p className="text-xs text-red-400 mt-2 line-clamp-1">
                          错误: {task.error}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0">
                      {task.status === "completed" && (
                        <div className="w-8 h-8 rounded-full bg-green-900/30 border border-green-700/50 flex items-center justify-center">
                          <span className="text-green-400 text-lg">✓</span>
                        </div>
                      )}
                      {task.status === "running" && (
                        <div className="w-8 h-8 rounded-full bg-blue-900/30 border border-blue-700/50 flex items-center justify-center">
                          <span className="text-blue-400 text-sm animate-spin">⟳</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
