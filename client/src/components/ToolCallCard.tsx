import { useState } from "react";

interface ToolCallProps {
  toolCall: {
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
  };
}

const TOOL_ICONS: Record<string, string> = {
  bash: "⚡",
  read: "📄",
  write: "✏️",
  edit: "🔧",
  ls: "📁",
  glob: "🔍",
  grep: "🔎",
  fetch: "🌐",
  google_search: "🔍",
  task: "📋",
  todoWrite: "✅",
};

export function ToolCallCard({ toolCall }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = TOOL_ICONS[toolCall.name] || "🔧";

  return (
    <div className="rounded-md border border-zinc-700 bg-zinc-900/50 overflow-hidden text-xs sm:text-sm">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 sm:gap-2 px-2 py-1.5 sm:px-3 sm:py-2 hover:bg-zinc-800/50 transition-colors text-left"
      >
        <span>{icon}</span>
        <span className="font-mono text-blue-400 shrink-0">{toolCall.name}</span>
        <span className="text-zinc-500 truncate flex-1 text-[11px] sm:text-xs">
          {formatInput(toolCall.input)}
        </span>
        {toolCall.result && (
          <span className="text-green-500 text-xs">✓</span>
        )}
        <span className="text-zinc-600">{expanded ? "▼" : "▶"}</span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          <div>
            <div className="text-xs text-zinc-500 mb-1">输入:</div>
            <pre className="text-xs text-zinc-300 bg-zinc-900 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {toolCall.result && (
            <div>
              <div className="text-xs text-zinc-500 mb-1">结果:</div>
              <pre className="text-xs text-zinc-300 bg-zinc-900 rounded p-2 overflow-x-auto max-h-60 overflow-y-auto">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatInput(input: Record<string, unknown>): string {
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.dir_path) return String(input.dir_path);
  if (input.pattern) return String(input.pattern);
  if (input.query) return String(input.query);
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return `${keys[0]}: ${String(input[keys[0]]).slice(0, 50)}`;
}
