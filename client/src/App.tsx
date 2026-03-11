import { useState, useEffect, useCallback, useRef } from "react";
import { Sidebar } from "@/components/Sidebar";
import { ChatPanel } from "@/components/ChatPanel";
import { TaskList } from "@/components/TaskList";
import type { AdvancedOpts } from "@/components/ChatPanel";
import { ConfigModal } from "@/components/ConfigModal";
import { BASE_PATH, FALLBACK_MODELS } from "@/lib/types";
import type { SessionMeta, ChatMode, ModelInfo } from "@/lib/types";
import type { TreeNode } from "@/components/DirectoryTree";

interface Project {
  name: string;
  path: string;
}

type ViewMode = "tasks" | "chat";

function loadSaved<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const savedView = loadSaved("kwaicli_view", "tasks");
    const savedSession = loadSaved("kwaicli_session", null);
    // 如果有保存的 session，应该显示 chat 视图
    return savedSession ? "chat" : savedView;
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState(() => loadSaved("kwaicli_project", ""));
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(() => loadSaved("kwaicli_session", null));
  const [model, setModel] = useState(() => loadSaved("kwaicli_model", "claude-4.5-sonnet"));
  const [approvalMode, setApprovalMode] = useState("default");
  const [chatMode, setChatMode] = useState<ChatMode>("agent");
  const [advancedOpts, setAdvancedOpts] = useState<AdvancedOpts>({
    planModel: "",
    smallModel: "",
    visionModel: "",
    systemPrompt: "",
    appendSystemPrompt: "",
    language: "",
    browser: false,
    thinkingLevel: "high",
    notificationEnabled: false,
    notificationRobotKey: "",
  });
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(FALLBACK_MODELS);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
  }, []);
  const [configModal, setConfigModal] = useState<string | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const mountCounter = useRef(0);
  const [chatKey, setChatKey] = useState("init");

  useEffect(() => {
    console.log("[App.tsx] Version: 2026-03-10-vite, Fetching projects, BASE_PATH:", BASE_PATH);
    setLoadingProjects(true);
    
    const timeoutId = setTimeout(() => {
      console.error("[App.tsx] Request timeout!");
      setLoadingProjects(false);
      alert("加载超时！请检查网络或刷新页面");
    }, 15000);
    
    // 使用 tree=true 获取树状结构
    fetch(`${BASE_PATH}/api/projects?tree=true`)
      .then((r) => {
        clearTimeout(timeoutId);
        console.log("[App.tsx] Projects response status:", r.status);
        if (!r.ok) {
          alert(`API 错误: HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        console.log("[App.tsx] Tree data:", data);
        // 保存原始树数据给 Sidebar 使用
        if (data.tree) {
          setTreeData(data.tree);
        }
        // 将树展平为列表供向后兼容
        if (data.tree) {
          const flattenTree = (nodes: Array<{ name: string; path: string; children?: Array<unknown> }>): Array<{ name: string; path: string }> => {
            let result: Array<{ name: string; path: string }> = [];
            for (const node of nodes) {
              result.push({ name: node.name, path: node.path });
              if (node.children) {
                result = result.concat(flattenTree(node.children as Array<{ name: string; path: string; children?: Array<unknown> }>));
              }
            }
            return result;
          };
          setProjects(flattenTree(data.tree));
        } else if (data.projects) {
          setProjects(data.projects);
        }
      })
      .catch((err: Error) => {
        clearTimeout(timeoutId);
        console.error("[App.tsx] Fetch projects error:", err);
        alert(`加载失败: ${err.message}`);
      })
      .finally(() => setLoadingProjects(false));

    // 并行加载可用模型列表
    fetch(`${BASE_PATH}/api/models`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.models?.length) setAvailableModels(data.models);
      })
      .catch(() => { /* 失败时保持 FALLBACK_MODELS */ });
  }, []);

  const fetchSessions = useCallback((projectPath: string) => {
    if (!projectPath) {
      setSessions([]);
      return;
    }
    setLoadingSessions(true);
    fetch(`${BASE_PATH}/api/sessions?project=${encodeURIComponent(projectPath)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.sessions) setSessions(data.sessions);
      })
      .catch(console.error)
      .finally(() => setLoadingSessions(false));
  }, []);

  useEffect(() => {
    fetchSessions(selectedProject);
  }, [selectedProject, fetchSessions]);

  const remountChat = useCallback(() => {
    mountCounter.current += 1;
    setChatKey(`mount-${mountCounter.current}`);
  }, []);

  useEffect(() => {
    localStorage.setItem("kwaicli_view", JSON.stringify(viewMode));
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem("kwaicli_project", JSON.stringify(selectedProject));
  }, [selectedProject]);

  useEffect(() => {
    localStorage.setItem("kwaicli_session", JSON.stringify(selectedSession));
  }, [selectedSession]);

  useEffect(() => {
    localStorage.setItem("kwaicli_model", JSON.stringify(model));
  }, [model]);

  const handleSelectProject = (path: string) => {
    setSelectedProject(path);
    setSelectedSession(null);
    remountChat();
  };

  const handleSelectSession = (id: string, project?: string) => {
    // 如果指定了项目且与当前不同，先切换项目
    if (project && project !== selectedProject) {
      setSelectedProject(project);
    }
    setSelectedSession(id);
    setViewMode("chat");
    remountChat();
  };

  const handleNewSession = () => {
    setSelectedSession(null);
    setViewMode("chat");
    remountChat();
  };

  const handleNewProject = async (name: string) => {
    try {
      const res = await fetch(`${BASE_PATH}/api/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (data.path) {
        setProjects((prev) => [
          ...prev,
          { name: data.name, path: data.path },
        ]);
        setSelectedProject(data.path);
        setSelectedSession(null);
      }
    } catch (err) {
      console.error("create project failed", err);
    }
  };

  const handleSessionCreated = useCallback((id: string) => {
    setSelectedSession(id);
    fetchSessions(selectedProject);
  }, [fetchSessions, selectedProject]);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <main className="h-dvh flex bg-zinc-950 relative overflow-hidden">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile, shown as overlay when sidebarOpen */}
      <div className={`
        fixed inset-y-0 left-0 z-50 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 md:z-auto
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
      `}>
        <Sidebar
          projects={projects}
          treeData={treeData}
          selectedProject={selectedProject}
          onSelectProject={(path) => {
            handleSelectProject(path);
            setSidebarOpen(false);
          }}
          sessions={sessions}
          selectedSession={selectedSession}
          onSelectSession={(id) => {
            handleSelectSession(id);
            setSidebarOpen(false);
          }}
          onNewSession={() => {
            handleNewSession();
            setSidebarOpen(false);
          }}
          onNewProject={handleNewProject}
          onOpenConfig={setConfigModal}
          loadingProjects={loadingProjects}
          loadingSessions={loadingSessions}
        />
      </div>

      <div className="flex-1 min-w-0">
        {viewMode === "tasks" ? (
          <TaskList
            selectedProject={selectedProject}
            model={model}
            chatMode={chatMode}
            advancedOpts={advancedOpts}
            onSelectSession={handleSelectSession}
            onSessionCreated={handleSessionCreated}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
          />
        ) : (
          <ChatPanel
            key={chatKey}
            selectedProject={selectedProject}
            initialSessionId={selectedSession}
            model={model}
            approvalMode={approvalMode}
            chatMode={chatMode}
            advancedOpts={advancedOpts}
            availableModels={availableModels}
            onModelChange={handleModelChange}
            onApprovalModeChange={setApprovalMode}
            onChatModeChange={setChatMode}
            onAdvancedOptsChange={(partial) =>
              setAdvancedOpts((prev) => ({ ...prev, ...partial }))
            }
            onSessionCreated={handleSessionCreated}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            onBackToTasks={() => setViewMode("tasks")}
          />
        )}
      </div>

      {configModal && (
        <ConfigModal
          type={configModal}
          selectedProject={selectedProject}
          onClose={() => setConfigModal(null)}
        />
      )}
    </main>
  );
}
