import { Router, Request, Response } from "express";
import { getProjectSessions, getSessionHistory } from "../lib/ssh-bridge";

const router = Router();

/**
 * GET /api/sessions
 * 获取项目会话列表
 */
router.get("/", async (req: Request, res: Response) => {
  const project = req.query.project as string;

  if (!project) {
    return res.status(400).json({ error: "project query param is required" });
  }

  try {
    const sessions = await getProjectSessions(project);
    return res.json({ sessions });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * GET /api/sessions/history
 * 获取会话历史记录
 */
router.get("/history", async (req: Request, res: Response) => {
  const project = req.query.project as string;
  const session = req.query.session as string;

  if (!project || !session) {
    return res.status(400).json({ error: "project and session query params are required" });
  }

  try {
    const events = await getSessionHistory(project, session);
    return res.json({ events });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errMsg });
  }
});

export default router;
