import { useState } from "react";
import type { SessionMeta } from "@/lib/types";
import { DirectoryTreeList, type TreeNode } from "./DirectoryTree";

interface Project {
  name: string;
  path: string;
}

interface SidebarProps {
  projects: Project[];
  treeData: TreeNode[];
  selectedProject: string;
  onSelectProject: (path: string) => void;
  sessions: SessionMeta[];
  selectedSession: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onNewProject: (name: string) => void;
  onOpenConfig: (type: string) => void;
  loadingProjects: boolean;
  loadingSessions: boolean;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = diffMs / 3600000;
    if (diffH < 1) return `${Math.round(diffMs / 60000)}分钟前`;
    if (diffH < 24) return `${Math.round(diffH)}小时前`;
    const diffD = diffH / 24;
    if (diffD < 7) return `${Math.round(diffD)}天前`;
    return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function Sidebar({
  projects,
  treeData,
  selectedProject,
  onSelectProject,
  sessions,
  selectedSession,
  onSelectSession,
  onNewSession,
  onNewProject,
  onOpenConfig,
  loadingProjects,
  loadingSessions,
}: SidebarProps) {
  const [projectSearch, setProjectSearch] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const filteredProjects = projects.filter((p) =>
    p.name.toLowerCase().includes(projectSearch.toLowerCase()) ||
    p.path.toLowerCase().includes(projectSearch.toLowerCase())
  );

  const mainSessions = sessions.filter((s) => !s.isSubAgent);

  if (sidebarCollapsed) {
    return (
      <div className="w-12 h-full bg-zinc-900 border-r border-zinc-800 flex flex-col items-center py-3 gap-3">
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="text-zinc-400 hover:text-zinc-200 text-lg"
          title="展开侧边栏"
        >
          ▶
        </button>
        <button
          onClick={onNewSession}
          className="text-zinc-400 hover:text-zinc-200 text-lg"
          title="新会话"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 h-full bg-zinc-900 border-r border-zinc-800 flex flex-col shrink-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-base font-bold text-zinc-100 flex items-center gap-2">
          🦞 <span>Aimsry-webclaw</span>
        </h1>
        <div className="flex items-center gap-1">
          <button
            onClick={onNewSession}
            className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            title="新会话"
          >
            + 新会话
          </button>
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="text-zinc-500 hover:text-zinc-300 px-1"
            title="收起"
          >
            ◀
          </button>
        </div>
      </div>

      {/* Project Selector */}
      <div className="px-3 py-2 border-b border-zinc-800">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">
          工程目录
        </div>
        <input
          type="text"
          placeholder="搜索项目..."
          value={projectSearch}
          onChange={(e) => setProjectSearch(e.target.value)}
          className="w-full bg-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 mb-2"
        />

        <div className="max-h-52 overflow-y-auto space-y-0.5 scrollbar-thin">
          {loadingProjects ? (
            <div className="text-xs text-zinc-500 py-2 text-center">
              加载中...
            </div>
          ) : projectSearch ? (
            // 搜索模式：显示平铺列表
            filteredProjects.length === 0 ? (
              <div className="text-xs text-zinc-500 py-2 text-center">
                无匹配项目
              </div>
            ) : (
              filteredProjects.map((p) => (
                <button
                  key={p.path}
                  onClick={() => onSelectProject(p.path)}
                  className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
                    selectedProject === p.path
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  }`}
                  title={p.path}
                >
                  <div className="flex items-center gap-1">
                    <span>📂</span>
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.path !== p.name && (
                      <span className="text-[10px] text-zinc-600 truncate max-w-[120px]">
                        {p.path.replace(/^~\//, "")}
                      </span>
                    )}
                  </div>
                </button>
              ))
            )
          ) : (
            // 树状模式：显示可展开的树
            <DirectoryTreeList
              roots={treeData}
              selectedPath={selectedProject}
              onSelect={onSelectProject}
            />
          )}
        </div>

        {/* Create New Project */}
        {showNewProject ? (
          <div className="mt-2 flex gap-1">
            <input
              type="text"
              placeholder="新目录名"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newProjectName.trim()) {
                  onNewProject(newProjectName.trim());
                  setNewProjectName("");
                  setShowNewProject(false);
                }
                if (e.key === "Escape") setShowNewProject(false);
              }}
              className="flex-1 min-w-0 bg-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-blue-500/50"
              autoFocus
            />
            <button
              onClick={() => {
                if (newProjectName.trim()) {
                  onNewProject(newProjectName.trim());
                  setNewProjectName("");
                  setShowNewProject(false);
                }
              }}
              className="px-2 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 text-white rounded"
            >
              创建
            </button>
            <button
              onClick={() => {
                setShowNewProject(false);
                setNewProjectName("");
              }}
              className="px-1.5 py-1 text-xs text-zinc-500 hover:text-zinc-300"
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowNewProject(true)}
            className="mt-1 w-full text-left text-xs px-2 py-1.5 rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
          >
            + 创建新目录
          </button>
        )}
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">
          会话记录
          {selectedProject && (
            <span className="text-zinc-600 ml-1 normal-case">
              ({mainSessions.length})
            </span>
          )}
        </div>

        {!selectedProject ? (
          <div className="text-xs text-zinc-600 py-4 text-center">
            请先选择工程目录
          </div>
        ) : loadingSessions ? (
          <div className="text-xs text-zinc-500 py-4 text-center">
            加载会话...
          </div>
        ) : mainSessions.length === 0 ? (
          <div className="text-xs text-zinc-600 py-4 text-center">
            暂无历史会话
          </div>
        ) : (
          <div className="space-y-0.5">
            {mainSessions.map((s) => (
              <button
                key={s.id}
                onClick={() => onSelectSession(s.id)}
                className={`w-full text-left px-2 py-2 rounded transition-colors ${
                  selectedSession === s.id
                    ? "bg-blue-600/20 text-blue-400"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                }`}
              >
                <div className="font-mono text-xs truncate">{s.id}</div>
                <div className="text-[10px] text-zinc-600 mt-0.5">
                  {formatDate(s.updatedAt)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Config Section */}
      <div className="px-3 py-2 border-t border-zinc-800 space-y-0.5">
        <div className="text-[11px] text-zinc-500 uppercase tracking-wider mb-1.5 font-medium">
          设置
        </div>
        {[
          { type: "global", icon: "⚙️", label: "全局配置" },
          { type: "project", icon: "📂", label: "项目配置", needsProject: true },
        ].map((item) => (
          <button
            key={item.type}
            onClick={() => onOpenConfig(item.type)}
            disabled={item.needsProject && !selectedProject}
            className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
              item.needsProject && !selectedProject
                ? "text-zinc-600 cursor-not-allowed"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
            title={item.needsProject && !selectedProject ? "请先选择项目" : ""}
          >
            {item.icon} {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
