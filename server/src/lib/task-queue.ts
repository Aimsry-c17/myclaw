import { promises as fs } from "fs";
import path from "path";
import type { TaskQueueState, ProcessInfo } from "./types";
import { taskManager } from "./task-manager";
import { executeFlickcli, stopProcess } from "./ssh-bridge";

/**
 * Task Queue
 * 
 * 负责任务队列的管理和调度：
 * - 任务入队/出队
 * - 并发控制（最多 3 个任务同时执行）
 * - 队列状态持久化
 * - 自动恢复未完成任务
 */
class TaskQueue {
  private queue: string[] = [];           // 待执行任务队列
  private running = new Set<string>();    // 正在执行的任务集合
  private maxConcurrent = 3;              // 最大并发数
  private queueFile: string;
  private processing = false;

  constructor(tasksDir = "/tmp/kwaicli-tasks") {
    this.queueFile = path.join(tasksDir, "queue.json");
    this.init();
  }

  /**
   * 初始化队列
   */
  private async init() {
    await this.loadQueue();
    this.startProcessing();
    console.log("[TaskQueue] Initialized");
  }

  /**
   * 保存队列状态到文件
   */
  private async saveQueue(): Promise<void> {
    const state: TaskQueueState = {
      queue: this.queue,
      running: Array.from(this.running),
    };

    try {
      await fs.writeFile(this.queueFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error("[TaskQueue] Failed to save queue:", error);
    }
  }

  /**
   * 从文件恢复队列状态
   */
  private async loadQueue(): Promise<void> {
    try {
      const data = await fs.readFile(this.queueFile, "utf-8");
      const state: TaskQueueState = JSON.parse(data);

      this.queue = state.queue || [];
      this.running = new Set(state.running || []);

      console.log(
        `[TaskQueue] Loaded queue: ${this.queue.length} pending, ${this.running.size} running`
      );

      // 恢复正在执行的任务
      for (const taskId of this.running) {
        // 重新执行（因为服务重启，之前的执行已中断）
        this.executeTask(taskId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[TaskQueue] Failed to load queue:", error);
      }
      // 首次启动，队列为空
      this.queue = [];
      this.running = new Set();
    }
  }

  /**
   * 添加任务到队列
   */
  async enqueue(taskId: string): Promise<void> {
    this.queue.push(taskId);
    await this.saveQueue();
    console.log(
      `[TaskQueue] Task enqueued: ${taskId}, queue length: ${this.queue.length}`
    );
  }

  /**
   * 启动队列处理循环
   */
  private startProcessing() {
    // 每秒检查一次队列
    setInterval(() => {
      this.processQueue();
    }, 1000);
  }

  /**
   * 处理队列
   */
  private async processQueue() {
    // 防止并发处理
    if (this.processing) return;
    this.processing = true;

    try {
      // 检查是否达到并发上限
      while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
        const taskId = this.queue.shift();
        if (!taskId) break;

        await this.saveQueue();

        // 标记为执行中
        this.running.add(taskId);
        await this.saveQueue();

        // 异步执行任务（不等待完成）
        this.executeTask(taskId);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * 执行任务
   */
  private async executeTask(taskId: string) {
    console.log(`[TaskQueue] Starting task: ${taskId}`);

    try {
      // 获取任务信息
      const task = await taskManager.getTask(taskId);
      if (!task) {
        console.error(`[TaskQueue] Task not found: ${taskId}`);
        this.running.delete(taskId);
        await this.saveQueue();
        return;
      }

      // 检查是否已请求取消
      if (task.cancellationRequested) {
        console.log(`[TaskQueue] Task already cancelled: ${taskId}`);
        await taskManager.updateTask(taskId, {
          status: "cancelled",
          completedAt: Date.now(),
        });
        this.running.delete(taskId);
        await this.saveQueue();
        return;
      }

      // 更新任务状态为执行中
      await taskManager.updateTask(taskId, {
        status: "running",
        startedAt: Date.now(),
      });

      // 执行 flickcli
      await this.runFlickcli(taskId);

      // 再次检查是否被取消
      const updatedTask = await taskManager.getTask(taskId);
      if (updatedTask?.status === "cancelling" || updatedTask?.status === "cancelled") {
        console.log(`[TaskQueue] Task was cancelled during execution: ${taskId}`);
        
        // 如果状态还是 cancelling，更新为 cancelled
        if (updatedTask.status === "cancelling") {
          await taskManager.updateTask(taskId, {
            status: "cancelled",
            completedAt: Date.now(),
          });
        }
        
        return;  // 已被取消，不更新为 completed
      }

      // 更新任务状态为完成
      await taskManager.updateTask(taskId, {
        status: "completed",
        completedAt: Date.now(),
      });

      console.log(`[TaskQueue] Task completed: ${taskId}`);

      // 发送完成通知（如果配置了）
      await this.sendCompletionNotification(taskId);
    } catch (error) {
      console.error(`[TaskQueue] Task failed: ${taskId}`, error);

      // 检查是否是取消导致的错误
      const task = await taskManager.getTask(taskId);
      if (task?.status === "cancelling" || task?.status === "cancelled") {
        console.log(`[TaskQueue] Task cancelled (via error): ${taskId}`);
        await taskManager.updateTask(taskId, {
          status: "cancelled",
          completedAt: Date.now(),
        });
      } else {
        // 更新任务状态为失败
        await taskManager.updateTask(taskId, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
      }
    } finally {
      // 从执行中移除
      this.running.delete(taskId);
      await this.saveQueue();
      
      // 最后的兜底检查：确保 cancelling 状态转为 cancelled
      const finalTask = await taskManager.getTask(taskId);
      if (finalTask?.status === "cancelling") {
        console.log(`[TaskQueue] Final cleanup: converting cancelling to cancelled: ${taskId}`);
        await taskManager.updateTask(taskId, {
          status: "cancelled",
          completedAt: Date.now(),
        });
      }
    }
  }

  /**
   * 运行 flickcli
   */
  private async runFlickcli(taskId: string) {
    const task = await taskManager.getTask(taskId);
    if (!task) return;

    // 构建 flickcli 参数
    const opts: Record<string, unknown> = {
      sessionId: task.sessionId || undefined,  // null 转为 undefined，让 CLI 创建新 session
      cwd: task.project,
      model: task.model,
      approvalMode: task.approvalMode,
      chatMode: task.chatMode,
    };

    // 合并高级选项
    if (task.advancedOpts) {
      Object.assign(opts, task.advancedOpts);
    }

    let realSessionId: string | null = null;
    let processInfo: ProcessInfo | null = null;

    // 定期检查取消请求
    const cancelCheckInterval = setInterval(async () => {
      const currentTask = await taskManager.getTask(taskId);
      if (currentTask?.cancellationRequested && processInfo) {
        console.log(`[TaskQueue] Cancellation requested for task: ${taskId}`);
        clearInterval(cancelCheckInterval);
        
        // 停止进程
        const stopped = await stopProcess(processInfo);
        console.log(`[TaskQueue] Process stop result: ${stopped}`);
        
        // 更新任务状态
        await taskManager.updateTask(taskId, {
          status: "cancelled",
          completedAt: Date.now(),
        });
      }
    }, 1000);  // 每秒检查一次

    try {
      // 添加进程启动回调
      opts.onProcessStarted = (info: ProcessInfo) => {
        processInfo = info;
        console.log(`[TaskQueue] Process started for task ${taskId}:`, info);
        // 保存进程信息到任务
        taskManager.updateTask(taskId, { processInfo: info });
      };

      // 执行 flickcli 并收集输出
      for await (const event of executeFlickcli(task.message, opts)) {
        // 检查取消请求
        const currentTask = await taskManager.getTask(taskId);
        if (currentTask?.cancellationRequested) {
          console.log(`[TaskQueue] Breaking event loop due to cancellation: ${taskId}`);
          break;  // 停止接收事件
        }

        // 从事件中提取真实的 sessionId
        if (!realSessionId) {
          // 优先从 init 事件中提取（CLI 分配的 sessionId）
          if (event.type === "system" && event.subtype === "init" && event.sessionId) {
            realSessionId = event.sessionId;
            console.log(`[TaskQueue] Extracted sessionId from init event: ${realSessionId}`);
            await taskManager.updateTask(taskId, { sessionId: realSessionId });
          }
          // 备选：从 meta 事件的 -r 参数中提取
          else if (event.type === "meta" && event.command) {
            const match = event.command.match(/-r\s+([a-f0-9]{8})\b/);
            if (match) {
              realSessionId = match[1];
              console.log(`[TaskQueue] Extracted sessionId from meta command: ${realSessionId}`);
              await taskManager.updateTask(taskId, { sessionId: realSessionId });
            }
          }
        }

        // 将事件保存到任务输出
        await taskManager.appendOutput(taskId, event);
      }
    } finally {
      // 清理取消检查定时器
      clearInterval(cancelCheckInterval);
      
      // 检查任务状态，如果是 cancelling，转换为 cancelled
      const finalTask = await taskManager.getTask(taskId);
      if (finalTask?.status === "cancelling") {
        console.log(`[TaskQueue] Converting cancelling to cancelled: ${taskId}`);
        await taskManager.updateTask(taskId, {
          status: "cancelled",
          completedAt: Date.now(),
        });
      }
    }
  }

  /**
   * 发送任务完成通知
   */
  private async sendCompletionNotification(taskId: string) {
    try {
      const task = await taskManager.getTask(taskId);
      if (!task) return;

      // 检查是否配置了推送通知
      const advancedOpts = task.advancedOpts as any;
      if (!advancedOpts?.notificationEnabled || !advancedOpts?.notificationRobotKey) {
        return;
      }

      const robotKey = advancedOpts.notificationRobotKey;
      
      // 构建通知消息
      const taskTitle = task.message.length > 50 
        ? task.message.slice(0, 50) + "..." 
        : task.message;
      const messageContent = `✅ 您的任务已完成\n\n任务内容：${taskTitle}\n完成时间：${new Date(task.completedAt || Date.now()).toLocaleString('zh-CN')}`;

      console.log(`[TaskQueue] Sending notification for task: ${taskId}`);

      const KIM_MCP_API = "https://wanqing.corp.kuaishou.com/api/mcp/invoke";
      const KIM_MCP_ID = "555ff41e-835b-4524-8d9a-8576893f6b14";

      const response = await fetch(KIM_MCP_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mcpId: KIM_MCP_ID,
          toolName: "sendRobotMessage",
          arguments: {
            robotKey,
            messageType: "text",
            messageContent,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Notification failed: HTTP ${response.status}`);
      }

      const result = await response.json();
      console.log(`[TaskQueue] Notification sent successfully:`, result);
    } catch (error) {
      console.error(`[TaskQueue] Failed to send notification:`, error);
      // 通知失败不影响任务完成状态
    }
  }

  /**
   * 获取队列状态
   */
  getStatus(): {
    queueLength: number;
    runningCount: number;
    runningTasks: string[];
  } {
    return {
      queueLength: this.queue.length,
      runningCount: this.running.size,
      runningTasks: Array.from(this.running),
    };
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      console.warn(`[TaskQueue] Cannot cancel: task not found: ${taskId}`);
      return false;
    }

    console.log(`[TaskQueue] Cancelling task: ${taskId}, current status: ${task.status}`);

    // 如果还在队列中，直接移除
    const queueIndex = this.queue.indexOf(taskId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      await this.saveQueue();
      await taskManager.updateTask(taskId, {
        status: "cancelled",
        completedAt: Date.now(),
      });
      console.log(`[TaskQueue] Task removed from queue: ${taskId}`);
      return true;
    }

    // 如果正在执行，标记为取消请求
    if (this.running.has(taskId) && task.status === "running") {
      await taskManager.updateTask(taskId, {
        status: "cancelling",
        cancellationRequested: true,
      });
      
      // 如果有进程信息，立即尝试停止
      if (task.processInfo) {
        console.log(`[TaskQueue] Stopping process for task: ${taskId}`);
        await stopProcess(task.processInfo);
      }
      
      console.log(`[TaskQueue] Task cancellation requested: ${taskId}`);
      return true;
    }

    // 任务已完成或失败，无法取消
    if (task.status === "completed" || task.status === "failed") {
      console.warn(`[TaskQueue] Cannot cancel: task already ${task.status}: ${taskId}`);
      return false;
    }

    // 已经在取消中或已取消
    if (task.status === "cancelling" || task.status === "cancelled") {
      console.log(`[TaskQueue] Task already ${task.status}: ${taskId}`);
      return true;
    }

    console.warn(`[TaskQueue] Cannot cancel: unexpected task status ${task.status}: ${taskId}`);
    return false;
  }
}

// 导出单例
export const taskQueue = new TaskQueue();
