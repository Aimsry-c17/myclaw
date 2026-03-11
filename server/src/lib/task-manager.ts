import { promises as fs } from "fs";
import path from "path";
import type { Task, FlickcliEvent } from "./types";

/**
 * Task Manager
 * 
 * 负责任务的生命周期管理：
 * - 创建任务
 * - 查询任务状态
 * - 更新任务数据
 * - 持久化到文件系统
 */
class TaskManager {
  private tasksDir: string;

  constructor(tasksDir = "/tmp/kwaicli-tasks") {
    this.tasksDir = tasksDir;
    this.ensureTasksDir();
  }

  /**
   * 确保任务目录存在
   */
  private async ensureTasksDir() {
    try {
      await fs.mkdir(this.tasksDir, { recursive: true });
    } catch (error) {
      console.error("[TaskManager] Failed to create tasks directory:", error);
    }
  }

  /**
   * 生成任务 ID
   */
  private generateTaskId(): string {
    return `task-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /**
   * 获取任务文件路径
   */
  private getTaskFilePath(taskId: string): string {
    return path.join(this.tasksDir, `${taskId}.json`);
  }

  /**
   * 创建新任务
   */
  async createTask(params: {
    sessionId: string | null;  // null 表示让 CLI 创建新 session
    project: string;
    message: string;
    model?: string;
    approvalMode?: string;
    chatMode?: "agent" | "plan" | "ask";
    advancedOpts?: Record<string, unknown>;
  }): Promise<Task> {
    const taskId = this.generateTaskId();

    const task: Task = {
      id: taskId,
      sessionId: params.sessionId,
      project: params.project,
      message: params.message,
      model: params.model,
      status: "pending",
      output: [],
      createdAt: Date.now(),
      approvalMode: params.approvalMode,
      chatMode: params.chatMode,
      advancedOpts: params.advancedOpts,
    };

    await this.saveTask(task);
    console.log(`[TaskManager] Created task: ${taskId}, sessionId: ${params.sessionId || 'auto'}`);

    return task;
  }

  /**
   * 保存任务到文件
   */
  async saveTask(task: Task): Promise<void> {
    const filePath = this.getTaskFilePath(task.id);
    try {
      await fs.writeFile(filePath, JSON.stringify(task, null, 2));
    } catch (error) {
      console.error(`[TaskManager] Failed to save task ${task.id}:`, error);
      throw error;
    }
  }

  /**
   * 从文件加载任务
   */
  async getTask(taskId: string): Promise<Task | null> {
    const filePath = this.getTaskFilePath(taskId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as Task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[TaskManager] Failed to load task ${taskId}:`, error);
      }
      return null;
    }
  }

  /**
   * 更新任务
   */
  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null> {
    const task = await this.getTask(taskId);
    if (!task) {
      console.warn(`[TaskManager] Task not found: ${taskId}`);
      return null;
    }

    // 合并更新
    Object.assign(task, updates);

    await this.saveTask(task);
    return task;
  }

  /**
   * 添加输出事件到任务
   */
  async appendOutput(taskId: string, event: FlickcliEvent): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    task.output.push(event);
    await this.saveTask(task);
  }

  /**
   * 列出所有任务
   */
  async listTasks(): Promise<Task[]> {
    try {
      const files = await fs.readdir(this.tasksDir);
      const tasks: Task[] = [];

      for (const file of files) {
        if (!file.endsWith(".json") || file === "queue.json") {
          continue;
        }

        const taskId = file.replace(".json", "");
        const task = await this.getTask(taskId);
        if (task) {
          tasks.push(task);
        }
      }

      // 按创建时间倒序排列
      return tasks.sort((a, b) => b.createdAt - a.createdAt);
    } catch (error) {
      console.error("[TaskManager] Failed to list tasks:", error);
      return [];
    }
  }

  /**
   * 列出未完成的任务
   */
  async listPendingTasks(): Promise<Task[]> {
    const allTasks = await this.listTasks();
    return allTasks.filter(
      (task) => task.status === "pending" || task.status === "running"
    );
  }

  /**
   * 删除任务文件
   */
  async deleteTask(taskId: string): Promise<void> {
    const filePath = this.getTaskFilePath(taskId);
    try {
      await fs.unlink(filePath);
      console.log(`[TaskManager] Deleted task: ${taskId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`[TaskManager] Failed to delete task ${taskId}:`, error);
      }
    }
  }

  /**
   * 清理已完成的旧任务
   * @param maxAge 最大保留时间（毫秒），默认 24 小时
   */
  async cleanupOldTasks(maxAge = 24 * 60 * 60 * 1000): Promise<void> {
    const tasks = await this.listTasks();
    const now = Date.now();

    for (const task of tasks) {
      if (
        task.status === "completed" || task.status === "failed"
      ) {
        const age = now - task.createdAt;
        if (age > maxAge) {
          await this.deleteTask(task.id);
        }
      }
    }
  }
}

// 导出单例
export const taskManager = new TaskManager();
