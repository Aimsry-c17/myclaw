import { Router, Request, Response } from "express";
import { executeSSHCommand } from "../lib/ssh-bridge";

const router = Router();

interface ModelInfo {
  id: string;
  label: string;
  group: string;
  desc?: string;
}

const MODEL_META: Record<string, { label?: string; group: string; desc?: string }> = {
  "claude-4.6-sonnet":      { group: "Claude", label: "Claude Sonnet 4.6", desc: "最新旗舰" },
  "claude-4.5-sonnet":      { group: "Claude", label: "Claude Sonnet 4.5", desc: "预览版" },
  "claude-haiku-4.5":       { group: "Claude", label: "Claude Haiku 4.5", desc: "快速轻量" },
  "claude-opus-4-6":        { group: "Claude", label: "Claude Opus 4.6", desc: "最强推理" },
  "claude-opus-4-5":        { group: "Claude", label: "Claude Opus 4.5", desc: "深度推理" },
  "kat-coder":              { group: "KAT", label: "KAT-Coder", desc: "编程专用" },
  "gemini-3.1-pro-preview": { group: "Gemini", label: "Gemini 3.1 Pro Preview", desc: "最新Gemini" },
  "gemini-3-pro-preview":   { group: "Gemini", label: "Gemini 3 Pro Preview", desc: "推理能力强" },
  "gemini-3-flash-preview": { group: "Gemini", label: "Gemini 3 Flash Preview", desc: "快速响应" },
  "gpt-5.2":                { group: "GPT", label: "GPT-5.2", desc: "最新GPT" },
  "gpt-5.1-codex-max":      { group: "GPT", label: "GPT 5.1 Codex Max", desc: "代码推理" },
  "gpt-5":                  { group: "GPT", label: "GPT-5", desc: "通用智能" },
  "gpt-5-codex":            { group: "GPT", label: "GPT-5 Codex", desc: "代码专用" },
  "gpt-5-nano":             { group: "GPT", label: "GPT-5 Nano", desc: "快速经济" },
  "kimi-k2.5":              { group: "Other", label: "Kimi K2.5", desc: "Moonshot推理" },
  "deepseek-v3.2":          { group: "Other", label: "DeepSeek V3.2", desc: "开源推理" },
  "minimax-m2.5":           { group: "Other", label: "MiniMax M2.5", desc: "最新MiniMax" },
  "minimax-m2.1":           { group: "Other", label: "MiniMax M2.1", desc: "指导助手" },
  "glm-5":                  { group: "Other", label: "GLM-5", desc: "最新GLM" },
  "glm-4.7":                { group: "Other", label: "GLM-4.7", desc: "快速经济" },
  "glm-4.6":                { group: "Other", label: "GLM-4.6", desc: "经济实惠" },
};

const HIDDEN_MODELS = new Set([
  "claude-opus-4-6",
  "claude-opus-4-5",
  "gemini-3-pro-preview",
  "gemini-3-pro-preview-thinking",
  "gemini-3-flash-preview",
]);

function isInternalId(id: string): boolean {
  return id.endsWith("-ep") || id.includes("instruct") || HIDDEN_MODELS.has(id);
}

let cachedModels: ModelInfo[] | null = null;
let cacheTime = 0;
const CACHE_TTL = 3600_000;

const extractScript = `
var fs = require("fs");
var src = fs.readFileSync("/usr/local/lib/node_modules/@ks-codeflicker/cli/dist/cli.mjs", "utf-8");
var marker = String.fromCharCode(34) + "claude-opus-4-";
var startSearch = 0;
while (true) {
  var idx = src.indexOf(marker, startSearch);
  if (idx < 0) break;
  var eqIdx = src.lastIndexOf("={", idx);
  if (eqIdx < 0 || idx - eqIdx > 200) { startSearch = idx + 1; continue; }
  var objStart = eqIdx + 1;
  var depth = 0, end = objStart;
  for (var i = objStart; i < src.length && i < objStart + 50000; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  var after = src.substring(end, end + 2000);
  if (after.includes("wanqing") || after.indexOf("\\u4e07\\u64ce") >= 0) {
    var objStr = src.substring(objStart, end);
    var ids = [];
    var d = 0, cur = "";
    for (var j = 1; j < objStr.length - 1; j++) {
      var c = objStr[j];
      if (c === "{") d++;
      else if (c === "}") d--;
      else if (c === "," && d === 0) {
        var m = cur.match(/^\\"([a-z0-9._-]+)\\"/);
        if (m) ids.push(m[1]);
        cur = ""; continue;
      }
      cur += c;
    }
    var m2 = cur.match(/^\\"([a-z0-9._-]+)\\"/);
    if (m2) ids.push(m2[1]);
    console.log(JSON.stringify(ids));
    process.exit(0);
  }
  startSearch = idx + 1;
}
console.log("[]");
`;

async function fetchModelsFromCLI(): Promise<ModelInfo[]> {
  if (cachedModels && Date.now() - cacheTime < CACHE_TTL) {
    return cachedModels;
  }

  try {
    const output = await executeSSHCommand(
      `node -e '${extractScript}' 2>/dev/null`
    );
    const firstLine = output.find((l: string) => l.trim().startsWith("["));
    if (!firstLine) throw new Error("No JSON output");

    const allIds: string[] = JSON.parse(firstLine);
    const userIds = allIds.filter((id) => !isInternalId(id));
    if (userIds.length === 0) throw new Error("Extracted 0 models");

    const models: ModelInfo[] = userIds.map((id) => {
      const meta = MODEL_META[id];
      if (meta) {
        return { id, label: meta.label || id, group: meta.group, desc: meta.desc };
      }
      let group = "Other";
      if (id.includes("claude") || id.includes("opus")) group = "Claude";
      else if (id.includes("gemini")) group = "Gemini";
      else if (id.includes("gpt") || id.includes("codex")) group = "GPT";
      else if (id.includes("kat")) group = "KAT";
      return { id, label: id, group };
    });

    const groupOrder: Record<string, number> = { KAT: 0, Claude: 1, Gemini: 2, GPT: 3, Other: 4 };
    models.sort((a, b) => (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9));

    cachedModels = models;
    cacheTime = Date.now();
    console.log(`[models] Fetched ${models.length} models from CLI`);
    return models;
  } catch (err) {
    console.error("[models] Failed to fetch from CLI:", err);
    if (cachedModels) return cachedModels;
    throw err;
  }
}

/**
 * GET /api/models
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const models = await fetchModelsFromCLI();
    return res.json({ models });
  } catch {
    return res.status(500).json({ error: "Failed to fetch models", models: [] });
  }
});

export default router;
