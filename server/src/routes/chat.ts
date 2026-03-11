import { Router, Request, Response } from "express";
import { taskManager } from "../lib/task-manager";
import { taskQueue } from "../lib/task-queue";

const router = Router();

/**
 * POST /api/chat
 * 创建任务并返回任务 ID
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      message,
      sessionId,
      cwd,
      model,
      planModel,
      smallModel,
      visionModel,
      approvalMode,
      systemPrompt,
      appendSystemPrompt,
      language,
      browser,
      tools,
      thinkingLevel,
      chatMode,
      notificationEnabled,
      notificationRobotKey,
    } = req.body;

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    if (!cwd) {
      return res.status(400).json({ error: "cwd (project path) is required" });
    }

    // 同一 session 同时只能有一个 pending/running 任务
    if (sessionId) {
      const allTasks = await taskManager.listTasks();
      const activeTask = allTasks.find(
        (t) =>
          t.sessionId === sessionId &&
          (t.status === "pending" || t.status === "running")
      );
      if (activeTask) {
        return res.status(409).json({
          error: "该会话已有任务正在执行中，请等待完成后再发送",
          activeTaskId: activeTask.id,
        });
      }
    }

    const task = await taskManager.createTask({
      sessionId: sessionId || null,
      project: cwd,
      message,
      model,
      approvalMode,
      chatMode,
      advancedOpts: {
        planModel,
        smallModel,
        visionModel,
        systemPrompt,
        appendSystemPrompt,
        language,
        browser,
        tools,
        thinkingLevel,
        notificationEnabled,
        notificationRobotKey,
      },
    });

    await taskQueue.enqueue(task.id);

    return res.json({
      taskId: task.id,
      sessionId: task.sessionId,
      status: task.status,
    });
  } catch (error) {
    console.error("[API /api/chat] Error:", error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
