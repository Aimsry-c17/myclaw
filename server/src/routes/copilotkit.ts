import { Router, Request, Response } from "express";
import { executeFlickcli } from "../lib/ssh-bridge";

const router = Router();

/**
 * POST /api/copilotkit
 * CopilotKit-compatible SSE endpoint
 */
router.post("/", async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;

  const lastUserMessage = extractLastUserMessage(body);
  const sessionId = (body.threadId as string) || undefined;
  const properties = body.properties as Record<string, unknown> | undefined;
  const cwd = (properties?.cwd as string) || undefined;

  if (!lastUserMessage) {
    return res.status(400).json({ error: "No user message found" });
  }

  // 设置 SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const emit = (event: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let messageCounter = 0;

  try {
    emit({
      type: "RUN_STARTED",
      threadId: sessionId || "new",
      runId: `run-${Date.now()}`,
    });

    let currentSessionId = sessionId;
    let textBuffer = "";

    for await (const event of executeFlickcli(lastUserMessage, { sessionId, cwd })) {
      if (event.type === "system" && "subtype" in event && event.subtype === "init") {
        currentSessionId = event.sessionId;
        emit({
          type: "STATE_SNAPSHOT",
          snapshot: {
            sessionId: event.sessionId,
            model: event.model,
            tools: event.tools,
            cwd: event.cwd,
          },
        });
      } else if (event.type === "message" && event.role === "assistant") {
        for (const item of event.content) {
          if ("type" in item && item.type === "text" && "text" in item) {
            const msgId = `msg-${++messageCounter}`;
            emit({ type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant" });
            emit({ type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: item.text });
            emit({ type: "TEXT_MESSAGE_END", messageId: msgId });
            textBuffer = item.text as string;
          } else if ("type" in item && item.type === "tool_use") {
            const toolItem = item as { id: string; name: string; input: Record<string, unknown> };
            emit({
              type: "TOOL_CALL_START",
              toolCallId: toolItem.id,
              toolCallName: toolItem.name,
              args: JSON.stringify(toolItem.input),
            });
          }
        }
      } else if (event.type === "message" && event.role === "tool") {
        for (const item of event.content) {
          if ("type" in item && item.type === "tool-result") {
            const toolResult = item as {
              toolCallId: string;
              toolName: string;
              result: { returnDisplay: string };
            };
            emit({
              type: "TOOL_CALL_END",
              toolCallId: toolResult.toolCallId,
              result: toolResult.result.returnDisplay,
            });
          }
        }
      } else if (event.type === "result") {
        if (!textBuffer && event.content) {
          const msgId = `msg-${++messageCounter}`;
          emit({ type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant" });
          emit({ type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: event.content });
          emit({ type: "TEXT_MESSAGE_END", messageId: msgId });
        }
      }
    }

    emit({ type: "RUN_FINISHED", threadId: currentSessionId });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    emit({ type: "error", content: errMsg });
  } finally {
    res.end();
  }
});

function extractLastUserMessage(body: Record<string, unknown>): string | null {
  const messages = body.messages as Array<{ role: string; content: string }> | undefined;
  if (!messages?.length) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return null;
}

export default router;
