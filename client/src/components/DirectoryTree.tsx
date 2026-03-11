import { useState } from "react";

export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
  isExpanded?: boolean;
}

interface DirectoryTreeProps {
  node: TreeNode;
  level: number;
  selectedPath: string;
  onSelect: (path: string) => void;
  onToggle?: (path: string) => void;
}

export function DirectoryTreeNode({
  node,
  level,
  selectedPath,
  onSelect,
  onToggle,
}: DirectoryTreeProps) {
  const [isExpanded, setIsExpanded] = useState(node.isExpanded ?? false);
  const hasChildren = node.children && node.children.length > 0;
  const isSelected = selectedPath === node.path;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
    onToggle?.(node.path);
  };

  const handleSelect = () => {
    onSelect(node.path);
  };

  return (
    <div>
      <button
        onClick={handleSelect}
        className={`w-full text-left text-xs px-2 py-1.5 rounded transition-colors flex items-center gap-1 ${
          isSelected
            ? "bg-blue-600/20 text-blue-400"
            : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
        title={node.path}
      >
        {/* 展开/折叠按钮 */}
        {hasChildren ? (
          <span
            onClick={handleToggle}
            className="w-4 h-4 flex items-center justify-center text-zinc-500 hover:text-zinc-300"
          >
            {isExpanded ? "▼" : "▶"}
          </span>
        ) : (
          <span className="w-4" />
        )}
        
        {/* 文件夹图标 */}
        <span>{isExpanded && hasChildren ? "📂" : "📁"}</span>
        
        {/* 目录名 */}
        <span className="flex-1 truncate">{node.name}</span>
      </button>

      {/* 子节点 */}
      {isExpanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <DirectoryTreeNode
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface DirectoryTreeListProps {
  roots: TreeNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
}

export function DirectoryTreeList({
  roots,
  selectedPath,
  onSelect,
}: DirectoryTreeListProps) {
  return (
    <div className="space-y-0.5">
      {roots.map((root) => (
        <DirectoryTreeNode
          key={root.path}
          node={root}
          level={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
