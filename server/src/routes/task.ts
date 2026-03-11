import { Router, Request, Response } from "express";
import { taskManager } from "../lib/task-manager";
import { taskQueue } from "../lib/task-queue";

const router = Router();

/**
 * GET /api/task/:id
 * 查询任务状态和输出
 */
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const task = await taskManager.getTask(id);

    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    return res.json({
      id: task.id,
      status: task.status,
      output: task.output,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
    });
  } catch (error) {
    console.error("[API /api/task/:id] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/task/:id/cancel
 * 取消正在执行或队列中的任务
 */
router.post("/:id/cancel", async (req: Request, res: Response) => {
  const { id: taskId } = req.params;

  try {
    const task = await taskManager.getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: "Task not found" });
    }

    if (task.status === "completed" || task.status === "failed") {
      return res.status(400).json({
        error: `Task already ${task.status}, cannot cancel`,
        status: task.status,
      });
    }

    if (task.status === "cancelled") {
      return res.json({
        success: true,
        status: "cancelled",
        message: "Task already cancelled",
      });
    }

    const cancelled = await taskQueue.cancelTask(taskId);

    if (cancelled) {
      const updatedTask = await taskManager.getTask(taskId);
      return res.json({
        success: true,
        status: updatedTask?.status || "cancelling",
        message: "Task cancellation requested",
      });
    } else {
      return res.status(500).json({ error: "Failed to cancel task" });
    }
  } catch (error) {
    console.error(`[API /api/task/${taskId}/cancel] Error:`, error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
