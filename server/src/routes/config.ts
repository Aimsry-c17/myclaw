import { Router, Request, Response } from "express";
import {
  getGlobalConfig,
  getProjectConfig,
  readRemoteFile,
} from "../lib/ssh-bridge";

const router = Router();

/**
 * GET /api/config
 */
router.get("/", async (req: Request, res: Response) => {
  const scope = (req.query.scope as string) || "global";
  const project = req.query.project as string | undefined;
  const file = req.query.file as string | undefined;

  try {
    if (file) {
      const content = await readRemoteFile(file);
      return res.json({ content });
    }

    if (scope === "project" && project) {
      const config = await getProjectConfig(project);
      return res.json(config);
    }

    const config = await getGlobalConfig();
    return res.json(config);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errMsg });
  }
});

export default router;
