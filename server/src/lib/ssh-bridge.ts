import { Client } from "ssh2";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { spawn, exec, ChildProcess } from "child_process";
import type { FlickcliEvent, SessionMeta, ProcessInfo } from "./types";

function detectLocalFlickcli(): boolean {
  if (process.env.FLICKCLI_MODE === "local") return true;
  // 标准安装路径
  if (existsSync("/usr/local/bin/flickcli")) return true;
  if (existsSync("/usr/local/lib/node_modules/@ks-codeflicker/cli")) return true;
  // pnpm 全局安装路径（macOS / Linux）
  const home = process.env.HOME || "";
  if (home && existsSync(join(home, "Library/pnpm/flickcli"))) return true;
  if (home && existsSync(join(home, ".local/share/pnpm/flickcli"))) return true;
  // 通用：尝试 which 命令检测
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("child_process");
    const result = (execSync("which flickcli 2>/dev/null", { encoding: "utf-8", timeout: 2000 }) as string).trim();
    if (result) return true;
  } catch { /* not found */ }
  return false;
}

const IS_LOCAL = detectLocalFlickcli();

// 进程跟踪
const sshConnections = new Map<string, Client>();
const localProcesses = new Map<number, ChildProcess>();

function findSSHAgentSocket(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  try {
    const entries = readdirSync("/tmp");
    for (const entry of entries) {
      if (entry.startsWith("com.apple.launchd.")) {
        const sockPath = join("/tmp", entry, "Listeners");
        try {
          statSync(sockPath);
          return sockPath;
        } catch {
          /* not valid */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function loadSSHConfig() {
  if (IS_LOCAL) return {};
  const agentSock = findSSHAgentSocket();
  const config: Record<string, unknown> = {
    host: process.env.FLICKCLI_SSH_HOST || "localhost",
    port: parseInt(process.env.FLICKCLI_SSH_PORT || "22"),
    username: process.env.FLICKCLI_SSH_USER || process.env.USER || "root",
  };

  if (agentSock) {
    config.agent = agentSock;
  } else {
    const home = process.env.HOME || "";
    for (const name of ["id_ed25519", "id_rsa"]) {
      try {
        config.privateKey = readFileSync(join(home, ".ssh", name));
        config.passphrase = process.env.FLICKCLI_SSH_PASSPHRASE;
        break;
      } catch {
        /* try next */
      }
    }
  }
  return config;
}

const SSH_CONFIG = loadSSHConfig();

type QueueItem =
  | { type: "event"; event: FlickcliEvent }
  | { type: "done" }
  | { type: "error"; error: Error };

export interface FlickcliOpts {
  sessionId?: string;
  cwd?: string;
  model?: string;
  planModel?: string;
  smallModel?: string;
  visionModel?: string;
  approvalMode?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  language?: string;
  browser?: boolean;
  tools?: Record<string, boolean>;
  thinkingLevel?: string;
  chatMode?: "agent" | "plan" | "ask";
  onProcessStarted?: (processInfo: ProcessInfo) => void;  // 新增：进程启动回调
}

// 缓存当前全局 thinkingLevel，避免每次请求都重复执行 config 命令
let cachedGlobalThinkingLevel: string | null = null;

export async function* executeFlickcli(
  message: string,
  opts: FlickcliOpts = {}
): AsyncGenerator<FlickcliEvent> {
  // thinkingLevel: 用户显式设置 > Claude 默认 high > 其他模型不设置
  const isClaude = (opts.model || "").toLowerCase().includes("claude");
  const effectiveThinking = opts.thinkingLevel && opts.thinkingLevel !== "off"
    ? opts.thinkingLevel
    : isClaude ? "high" : "";

  // 全局设置 thinkingLevel（不带 --scope project），仅在值变化时执行
  if (effectiveThinking && effectiveThinking !== cachedGlobalThinkingLevel) {
    const configCmd = `flickcli config set thinkingLevel ${effectiveThinking}`;
    console.log("[flickcli CONFIG]", configCmd);
    await executeSSHCommand(configCmd);
    cachedGlobalThinkingLevel = effectiveThinking;
  } else if (!effectiveThinking && cachedGlobalThinkingLevel) {
    const configCmd = `flickcli config remove thinkingLevel 2>/dev/null || true`;
    console.log("[flickcli CONFIG]", configCmd);
    await executeSSHCommand(configCmd);
    cachedGlobalThinkingLevel = null;
  }

  let finalMessage = message;
  let extraAppendPrompt = opts.appendSystemPrompt || "";

  if (opts.chatMode === "ask") {
    finalMessage = `/spec:brainstorm ${message}`;
  } else if (opts.chatMode === "plan") {
    const planInstruction = [
      "You are in PLAN MODE. Follow these rules strictly:",
      "1. ONLY use read-only tools: read, ls, glob, grep, fetch. Do NOT use write, edit, bash, or any destructive tool.",
      "2. Analyze the codebase thoroughly to understand the current state.",
      "3. Create a detailed, step-by-step implementation plan.",
      "4. For each step, specify which files to modify and what changes to make.",
      "5. Do NOT implement any changes - only plan them.",
      "6. Ask clarifying questions if the requirements are ambiguous.",
    ].join("\n");
    extraAppendPrompt = extraAppendPrompt
      ? `${extraAppendPrompt}\n\n${planInstruction}`
      : planInstruction;
  }

  const args = ["-q", "--output-format", "stream-json"];
  if (opts.sessionId) args.push("-r", opts.sessionId);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.model) args.push("-m", opts.model);
  if (opts.planModel) args.push("--plan-model", opts.planModel);
  if (opts.smallModel) args.push("--small-model", opts.smallModel);
  if (opts.visionModel) args.push("--vision-model", opts.visionModel);
  if (opts.approvalMode) args.push("--approval-mode", opts.approvalMode);
  if (opts.systemPrompt) args.push("--system-prompt", JSON.stringify(opts.systemPrompt));
  if (extraAppendPrompt) args.push("--append-system-prompt", JSON.stringify(extraAppendPrompt));
  if (opts.language) args.push("--language", opts.language);
  if (opts.browser) args.push("--browser");
  if (opts.tools) args.push("--tools", `'${JSON.stringify(opts.tools)}'`);
  args.push(JSON.stringify(finalMessage));

  const command = `flickcli ${args.join(" ")}`;
  console.log("[flickcli CMD]", command);

  yield {
    type: "meta",
    command,
    configCommand: effectiveThinking
      ? `flickcli config set thinkingLevel ${effectiveThinking}`
      : undefined,
  } as FlickcliEvent;

  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;

  function enqueue(item: QueueItem) {
    queue.push(item);
    notify?.();
    notify = null;
  }

  function dequeue(): Promise<QueueItem> {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    return new Promise<QueueItem>((resolve) => {
      notify = () => resolve(queue.shift()!);
    });
  }

  if (IS_LOCAL) {
    let buffer = "";
    const child = spawn("bash", ["-c", command], {
      env: { ...process.env, HOME: process.env.HOME || "" },
    });

    // 保存进程引用
    if (child.pid) {
      localProcesses.set(child.pid, child);
      // 通知调用者进程已启动
      opts.onProcessStarted?.({
        type: "local",
        pid: child.pid,
        killable: true,
      });
    }

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        if (!part.trim()) continue;
        try {
          enqueue({ type: "event", event: JSON.parse(part) });
        } catch {
          /* skip non-JSON */
        }
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      console.error("[flickcli stderr]", data.toString());
    });
    child.on("close", () => {
      if (buffer.trim()) {
        try {
          enqueue({ type: "event", event: JSON.parse(buffer) });
        } catch {
          /* skip */
        }
      }
      // 清理进程引用
      if (child.pid) {
        localProcesses.delete(child.pid);
      }
      enqueue({ type: "done" });
    });
    child.on("error", (err) => enqueue({ type: "error", error: err }));
  } else {
    const conn = new Client();
    let buffer = "";
    const connId = `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          enqueue({ type: "error", error: err });
          sshConnections.delete(connId);  // 确保清理
          conn.end();
          return;
        }
        
        // 保存 SSH 连接
        sshConnections.set(connId, conn);
        // 通知调用者进程已启动
        opts.onProcessStarted?.({
          type: "remote",
          sshConnId: connId,
          killable: true,
        });
        
        stream.on("data", (data: Buffer) => {
          buffer += data.toString();
          const parts = buffer.split("\n");
          buffer = parts.pop() || "";
          for (const part of parts) {
            if (!part.trim()) continue;
            try {
              enqueue({ type: "event", event: JSON.parse(part) });
            } catch {
              /* skip non-JSON */
            }
          }
        });
        stream.stderr.on("data", (data: Buffer) => {
          console.error("[flickcli stderr]", data.toString());
        });
        stream.on("close", () => {
          if (buffer.trim()) {
            try {
              enqueue({ type: "event", event: JSON.parse(buffer) });
            } catch {
              /* skip */
            }
          }
          // 清理 SSH 连接
          sshConnections.delete(connId);
          conn.end();
          enqueue({ type: "done" });
        });
      });
    });

    conn.on("error", (err) => {
      sshConnections.delete(connId);
      enqueue({ type: "error", error: err });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conn.connect(SSH_CONFIG as any);
  }

  while (true) {
    const item = await dequeue();
    if (item.type === "done") return;
    if (item.type === "error") throw item.error;
    yield item.event;
  }
}

export function executeSSHCommand(command: string): Promise<string[]> {
  if (IS_LOCAL) {
    return new Promise((resolve, reject) => {
      exec(command, { 
        env: { ...process.env, HOME: process.env.HOME || "" },
        maxBuffer: 100 * 1024 * 1024  // 100MB buffer
      }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        resolve(stdout.split("\n").filter((l) => l.trim()));
      });
    });
  }

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const chunks: Buffer[] = [];

    conn
      .on("ready", () => {
        conn.exec(command, { pty: false }, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          
          // 收集所有数据块
          stream.on("data", (data: Buffer) => {
            chunks.push(data);
          });
          
          stream.stderr.on("data", (data: Buffer) => {
            console.error("[ssh stderr]", data.toString());
          });
          
          stream.on("close", (code: number, signal: string) => {
            conn.end();
            
            if (code !== 0 && code !== undefined && chunks.length === 0) {
              return reject(new Error(`Command failed with code ${code}, signal ${signal}`));
            }
            
            // 合并所有数据块
            const buffer = Buffer.concat(chunks);
            const fullText = buffer.toString('utf-8');
            const lines = fullText.split("\n").filter((l) => l.trim());
            
            console.log(`[executeSSHCommand] Read ${buffer.length} bytes, split into ${lines.length} lines`);
            resolve(lines);
          });
        });
      })
      .on("error", reject)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .connect(SSH_CONFIG as any);
  });
}

export async function getProjectSessions(
  projectPath: string
): Promise<SessionMeta[]> {
  // 标准化路径：将 ~ 替换为实际家目录
  const remoteHome = process.env.FLICKCLI_SSH_HOME || process.env.HOME || "";
  const normalizedPath = projectPath.replace(/^~/, remoteHome);
  const slug = normalizedPath.replace(/^\//, "").replace(/\//g, "-");
  const dir = `~/.codeflicker/projects/${slug}`;

  const lines = await executeSSHCommand(
    `ls -lt --time-style=long-iso ${dir}/*.jsonl 2>/dev/null | head -30`
  );

  const sessions: SessionMeta[] = [];
  for (const line of lines) {
    // 支持两种格式：
    // 1. 标准格式: d7f92459.jsonl (8位hex)
    // 2. 临时格式: session-1772536341163.jsonl (带时间戳)
    const match = line.match(
      /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+.*\/((?:agent-)?(?:[a-f0-9]{8}|session-\d+))\.jsonl$/
    );
    if (match) {
      const rawId = match[3];
      sessions.push({
        id: rawId.replace(/^agent-/, ""),
        updatedAt: `${match[1]}T${match[2]}:00`,
        isSubAgent: rawId.startsWith("agent-"),
      });
    }
  }
  return sessions;
}

export async function createProjectDir(name: string): Promise<string> {
  const home = process.env.FLICKCLI_SSH_HOME || process.env.HOME || "~";
  const projectPath = `${home}/projects/${name}`;
  await executeSSHCommand(`mkdir -p ${projectPath}`);
  return projectPath;
}

export async function getGlobalConfig(): Promise<Record<string, unknown>> {
  const [configLines, remoteLines, mcpLines, skillsLines, agentsMdLines] = await Promise.all([
    executeSSHCommand(
      'cat ~/.codeflicker/config.json 2>/dev/null || echo "{}"'
    ),
    executeSSHCommand(
      'cat ~/.codeflicker/remote-base-config.json 2>/dev/null || echo "{}"'
    ),
    executeSSHCommand('flickcli mcp list -g 2>/dev/null || echo "{}"'),
    executeSSHCommand('ls -d ~/.cursor/skills/*/ ~/.codeflicker/skills/*/ 2>/dev/null || echo ""'),
    executeSSHCommand('cat ~/.codeflicker/AGENTS.md 2>/dev/null || echo ""'),
  ]);

  const parse = (lines: string[]) => {
    try {
      return JSON.parse(lines.join(""));
    } catch {
      return {};
    }
  };

  // 处理 Skills 列表
  const skillDirs = skillsLines.filter(l => l.trim()).map(l => {
    const trimmed = l.replace(/\/$/, "");
    const name = trimmed.split("/").pop() || trimmed;
    return { name, path: trimmed };
  });

  return {
    userConfig: parse(configLines),
    remoteConfig: parse(remoteLines),
    globalMCP: parse(mcpLines),
    globalSkills: skillDirs,
    globalAgentsMd: agentsMdLines.join("\n").trim(),
  };
}

export async function getProjectConfig(
  projectPath: string
): Promise<Record<string, unknown>> {
  const remoteHome = process.env.FLICKCLI_SSH_HOME || process.env.HOME || "";
  const normalizedPath = projectPath.replace(/^~/, remoteHome);
  
  const [rulesLines, agentsLines, mcpLines, skillsLines] = await Promise.all([
    executeSSHCommand(
      `find ${normalizedPath}/.codeflicker/rules/ -name '*.md' 2>/dev/null || echo ""`
    ),
    executeSSHCommand(`cat ${normalizedPath}/AGENTS.md 2>/dev/null || echo ""`),
    executeSSHCommand(
      `cd ${normalizedPath} && flickcli mcp list 2>/dev/null || echo "{}"`
    ),
    executeSSHCommand(
      `ls -d ${normalizedPath}/.codeflicker/skills/*/ ${normalizedPath}/.claude/skills/*/ 2>/dev/null || echo ""`
    ),
  ]);

  const parse = (lines: string[]) => {
    try {
      return JSON.parse(lines.join(""));
    } catch {
      return {};
    }
  };

  // 处理 Skills 列表
  const skillDirs = skillsLines.filter(l => l.trim()).map(l => {
    const trimmed = l.replace(/\/$/, "");
    const name = trimmed.split("/").pop() || trimmed;
    return { name, path: trimmed };
  });

  return {
    ruleFiles: rulesLines.filter((l) => l.trim()),
    agentsMd: agentsLines.join("\n").trim(),
    projectMCP: parse(mcpLines),
    projectSkills: skillDirs,
  };
}

export async function readRemoteFile(filePath: string): Promise<string> {
  const lines = await executeSSHCommand(
    `cat ${filePath} 2>/dev/null || echo ""`
  );
  return lines.join("\n");
}

export async function getSessionHistory(
  projectPath: string,
  sessionId: string
): Promise<Record<string, unknown>[]> {
  // 标准化路径：将 ~ 替换为实际家目录
  const remoteHome = process.env.FLICKCLI_SSH_HOME || process.env.HOME || "";
  const normalizedPath = projectPath.replace(/^~/, remoteHome);
  const slug = normalizedPath.replace(/^\//, "").replace(/\//g, "-");
  const file = `~/.codeflicker/projects/${slug}/${sessionId}.jsonl`;

  const lines = await executeSSHCommand(`tail -n +1 ${file} 2>/dev/null`);

  const events: Record<string, unknown>[] = [];
  let parseErrors = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    
    try {
      const event = JSON.parse(line);
      if (event.type === "message" || event.type === "system") {
        events.push(event);
      }
    } catch {
      parseErrors++;
    }
  }
  
  console.log(`[getSessionHistory] session=${sessionId}, lines=${lines.length}, events=${events.length}, errors=${parseErrors}`);
  
  return events;
}

/**
 * 停止正在执行的 flickcli 进程
 */
export async function stopProcess(processInfo: ProcessInfo): Promise<boolean> {
  console.log(`[stopProcess] Stopping process:`, processInfo);
  
  if (processInfo.type === "local" && processInfo.pid) {
    const child = localProcesses.get(processInfo.pid);
    if (child && !child.killed) {
      console.log(`[stopProcess] Killing local process PID ${processInfo.pid}`);
      
      // 先尝试 SIGTERM（优雅退出）
      try {
        child.kill('SIGTERM');
      } catch (err) {
        console.error(`[stopProcess] Failed to send SIGTERM:`, err);
      }
      
      // 5秒后如果还没退出，强制 SIGKILL
      setTimeout(() => {
        const stillExists = localProcesses.get(processInfo.pid!);
        if (stillExists && !stillExists.killed) {
          console.log(`[stopProcess] Force killing local process PID ${processInfo.pid}`);
          try {
            stillExists.kill('SIGKILL');
          } catch (err) {
            console.error(`[stopProcess] Failed to send SIGKILL:`, err);
          }
        }
        // 确保从 Map 中删除（可能进程已经结束但还在 Map 中）
        localProcesses.delete(processInfo.pid!);
      }, 5000);
      
      return true;
    } else {
      console.warn(`[stopProcess] Local process PID ${processInfo.pid} not found or already killed`);
      // 如果进程不存在，尝试清理 Map
      localProcesses.delete(processInfo.pid);
      return false;
    }
  } else if (processInfo.type === "remote" && processInfo.sshConnId) {
    const conn = sshConnections.get(processInfo.sshConnId);
    if (conn) {
      console.log(`[stopProcess] Closing SSH connection to stop remote process (connId: ${processInfo.sshConnId})`);
      
      // 直接关闭 SSH 连接，远程 flickcli 进程会因 stdin/pipe 断开而自动退出
      // 不再使用 pkill 通配符，避免误杀其他任务的进程
      try {
        conn.end();
      } catch (err) {
        console.error(`[stopProcess] Error closing connection:`, err);
      }
      sshConnections.delete(processInfo.sshConnId);
      console.log(`[stopProcess] SSH connection closed`);
      return true;
    } else {
      console.warn(`[stopProcess] SSH connection ${processInfo.sshConnId} not found`);
      sshConnections.delete(processInfo.sshConnId);
      return false;
    }
  }
  
  console.warn(`[stopProcess] Unknown process type or missing info`);
  return false;
}

