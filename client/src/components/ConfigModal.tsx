import { useState, useEffect, useCallback } from "react";
import { BASE_PATH } from "@/lib/types";

interface ConfigModalProps {
  type: string;
  selectedProject: string;
  onClose: () => void;
}

interface SkillInfo {
  name: string;
  path: string;
}

export function ConfigModal({
  type,
  selectedProject,
  onClose,
}: ConfigModalProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url = `${BASE_PATH}/api/config?scope=global`;
      if (type === "project" && selectedProject) {
        url = `${BASE_PATH}/api/config?scope=project&project=${encodeURIComponent(selectedProject)}`;
      }
      const res = await fetch(url);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [type, selectedProject]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const titleMap: Record<string, string> = {
    global: "全局配置",
    project: "项目配置",
  };

  const renderContent = () => {
    if (loading)
      return <div className="text-zinc-500 py-8 text-center">加载中...</div>;
    if (error)
      return <div className="text-red-400 py-8 text-center">{error}</div>;
    if (!data)
      return <div className="text-zinc-500 py-8 text-center">无数据</div>;

    if (type === "global") {
      const tabs = [
        { label: "用户配置", key: "userConfig" },
        { label: "模型路由", key: "remoteConfig" },
        { label: "全局 MCP", key: "globalMCP" },
        { label: "全局 Skills", key: "globalSkills" },
        { label: "全局 AGENTS.md", key: "globalAgentsMd" },
      ];
      return (
        <div>
          <div className="flex border-b border-zinc-700 mb-3 overflow-x-auto">
            {tabs.map((tab, i) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(i)}
                className={`px-3 py-2 text-xs transition-colors whitespace-nowrap ${
                  activeTab === i
                    ? "text-blue-400 border-b-2 border-blue-400"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {tabs[activeTab].key === "globalSkills" ? (
            renderSkillsList(data.globalSkills as SkillInfo[], "全局")
          ) : tabs[activeTab].key === "globalAgentsMd" ? (
            renderAgentsMd(data.globalAgentsMd as string, "全局")
          ) : (
            <pre className="text-xs text-zinc-300 bg-zinc-900 rounded-lg p-4 overflow-auto max-h-96">
              {JSON.stringify(
                data[tabs[activeTab].key] || {},
                null,
                2
              )}
            </pre>
          )}
        </div>
      );
    }

    if (type === "project") {
      const projectMCP = data.projectMCP as Record<string, unknown>;
      const projectSkills = (data.projectSkills as SkillInfo[]) || [];
      const agentsMd = (data.agentsMd as string) || "";
      const ruleFiles = (data.ruleFiles as string[]) || [];
      
      const tabs = [
        { label: "项目 AGENTS.md", key: "agentsMd" },
        { label: "项目 MCP", key: "projectMCP" },
        { label: "项目 Skills", key: "projectSkills" },
        { label: "规则文件", key: "ruleFiles" },
      ];

      return (
        <div>
          <div className="flex border-b border-zinc-700 mb-3 overflow-x-auto">
            {tabs.map((tab, i) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(i)}
                className={`px-3 py-2 text-xs transition-colors whitespace-nowrap ${
                  activeTab === i
                    ? "text-green-400 border-b-2 border-green-400"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          
          {tabs[activeTab].key === "agentsMd" ? (
            agentsMd ? (
              <pre className="text-xs text-zinc-300 bg-zinc-900 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap">
                {agentsMd}
              </pre>
            ) : (
              <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-4 text-center">
                该项目暂无 AGENTS.md
                <br />
                <span className="text-zinc-600 mt-1 block">
                  使用 /init 命令创建
                </span>
              </div>
            )
          ) : tabs[activeTab].key === "projectMCP" ? (
            projectMCP && Object.keys(projectMCP).length > 0 ? (
              <pre className="text-xs text-zinc-300 bg-zinc-900 rounded-lg p-4 overflow-auto max-h-96">
                {JSON.stringify(projectMCP, null, 2)}
              </pre>
            ) : (
              <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-4 text-center">
                该项目暂无 MCP 服务
                <br />
                <span className="text-zinc-600 mt-1 block">
                  使用 flickcli mcp add &lt;name&gt; &lt;command&gt; 添加
                </span>
              </div>
            )
          ) : tabs[activeTab].key === "projectSkills" ? (
            renderSkillsList(projectSkills, "项目")
          ) : tabs[activeTab].key === "ruleFiles" ? (
            ruleFiles.length > 0 ? (
              <ul className="space-y-1">
                {ruleFiles.map((f, i) => (
                  <li
                    key={i}
                    className="text-xs text-zinc-400 bg-zinc-900 rounded px-3 py-2 font-mono"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-4 text-center">
                该项目暂无规则文件
                <br />
                <span className="text-zinc-600 mt-1 block">
                  在项目的 .codeflicker/rules/ 目录下创建 .md 文件
                </span>
              </div>
            )
          ) : null}
        </div>
      );
    }

    return (
      <pre className="text-xs text-zinc-300 bg-zinc-900 rounded-lg p-4 overflow-auto max-h-96">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  const renderAgentsMd = (content: string, scope: string) => {
    if (!content) {
      return (
        <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-4 text-center">
          {scope}暂无 AGENTS.md
          <br />
          <span className="text-zinc-600 mt-1 block">
            {scope === "全局" 
              ? "在 ~/.codeflicker/AGENTS.md 创建全局规则"
              : "使用 /init 命令创建项目规则"
            }
          </span>
        </div>
      );
    }
    return (
      <pre className="text-xs text-zinc-300 bg-zinc-900 rounded-lg p-4 overflow-auto max-h-96 whitespace-pre-wrap">
        {content}
      </pre>
    );
  };

  const renderSkillsList = (skills: SkillInfo[], scope: string) => {
    if (!skills || skills.length === 0) {
      return (
        <div className="text-xs text-zinc-500 bg-zinc-900 rounded-lg p-4 text-center">
          {scope}暂无 Skills
          <br />
          <span className="text-zinc-600 mt-1 block">
            {scope === "全局"
              ? "在 ~/.cursor/skills/ 或 ~/.codeflicker/skills/ 创建 Skill"
              : "在项目的 .codeflicker/skills/ 或 .claude/skills/ 创建 Skill"
            }
          </span>
        </div>
      );
    }

    return (
      <ul className="space-y-1.5">
        {skills.map((skill, i) => (
          <li
            key={i}
            className="text-xs bg-zinc-900 rounded px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-blue-400">🔧</span>
              <span className="text-zinc-300 font-medium">{skill.name}</span>
            </div>
            <div className="text-zinc-600 font-mono mt-1 text-[10px]">
              {skill.path}
            </div>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-zinc-850 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        style={{ backgroundColor: "#1c1c1e" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div>
            <h3 className="text-base font-semibold text-zinc-100">
              {titleMap[type] || type}
            </h3>
            {selectedProject && type === "project" && (
              <p className="text-xs text-zinc-500 mt-0.5">
                {selectedProject}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300 text-lg leading-none"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">{renderContent()}</div>
      </div>
    </div>
  );
}
