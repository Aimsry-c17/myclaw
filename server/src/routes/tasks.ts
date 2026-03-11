import { Router, Request, Response } from "express";
import { taskManager } from "../lib/task-manager";

const router = Router();

/**
 * GET /api/tasks
 * 查询所有任务列表
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    const sessionId = req.query.sessionId as string | undefined;
    const limit = parseInt((req.query.limit as string) || "100");

    let tasks = await taskManager.listTasks();

    if (sessionId) {
      tasks = tasks.filter((task) => task.sessionId === sessionId);
    }

    if (status) {
      tasks = tasks.filter((task) => task.status === status);
    }

    if (sessionId) {
      tasks = tasks.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    } else {
      const sessionMap = new Map<string, typeof tasks[0]>();
      const noSessionTasks: typeof tasks = [];

      for (const task of tasks) {
        if (!task.sessionId) {
          noSessionTasks.push(task);
          continue;
        }
        const existing = sessionMap.get(task.sessionId);
        if (!existing || task.createdAt > existing.createdAt) {
          sessionMap.set(task.sessionId, task);
        }
      }

      tasks = [
        ...Array.from(sessionMap.values()),
        ...noSessionTasks,
      ].sort((a, b) => b.createdAt - a.createdAt);

      tasks = tasks.slice(0, limit);
    }

    const simplifiedTasks = tasks.map((task) => ({
      id: task.id,
      sessionId: task.sessionId,
      project: task.project,
      message: task.message,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      error: task.error,
      outputLength: task.output.length,
    }));

    return res.json({ tasks: simplifiedTasks, total: simplifiedTasks.length });
  } catch (error) {
    console.error("[API /api/tasks] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
