import { Router, Request, Response } from "express";
import { executeSSHCommand, createProjectDir } from "../lib/ssh-bridge";

const router = Router();

interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

function buildTree(paths: string[]): TreeNode[] {
  const tree: TreeNode[] = [];
  const map = new Map<string, TreeNode>();

  const sortedPaths = paths.sort((a, b) => {
    const depthA = a.split("/").length;
    const depthB = b.split("/").length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  for (const fullPath of sortedPaths) {
    const parts = fullPath.split("/").filter(Boolean);
    const name = parts[parts.length - 1] || fullPath;
    const displayPath = fullPath.replace(/^\/home\/[^/]+/, "~");

    const node: TreeNode = { name, path: displayPath, children: [] };
    map.set(displayPath, node);

    const parentParts = parts.slice(0, -1);
    if (parentParts.length === 0) {
      tree.push(node);
    } else {
      const parentPath = "/" + parentParts.join("/");
      const parentDisplayPath = parentPath.replace(/^\/home\/[^/]+/, "~");
      const parent = map.get(parentDisplayPath);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(node);
      } else {
        tree.push(node);
      }
    }
  }

  return tree;
}

/**
 * GET /api/projects
 */
router.get("/", async (req: Request, res: Response) => {
  const treeMode = req.query.tree === "true";

  try {
    const lines = await executeSSHCommand(
      `find ~ -maxdepth 2 -type d ! -path '*/\\.*' ! -path '*/node_modules*' ! -path '*/dist*' ! -path '*/.git*' 2>/dev/null | sort`
    );

    const paths = lines
      .filter(
        (l) =>
          l.trim() &&
          l !== process.env.HOME &&
          l.replace(/^~/, process.env.HOME || "") !== process.env.HOME
      )
      .slice(0, 200);

    if (treeMode) {
      const tree = buildTree(paths);
      return res.json({ tree });
    } else {
      const projects = paths.map((l) => {
        const path = l.trim();
        const parts = path.split("/");
        const name = parts[parts.length - 1];
        const displayPath = path.replace(/^\/home\/[^/]+/, "~");
        return { name, path: displayPath };
      });
      return res.json({ projects });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errMsg });
  }
});

/**
 * POST /api/projects
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }

    const sanitized = name.replace(/[^a-zA-Z0-9_\-.]/g, "-");
    const path = await createProjectDir(sanitized);
    return res.json({ name: sanitized, path });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: errMsg });
  }
});

export default router;
