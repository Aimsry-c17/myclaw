# WebClaw 项目讲解

## 项目整体介绍

这是一个叫 **KwaiCLI / Aimsry-webclaw** 的 **AI 编程助手 Web 界面**，本质上是给一个叫 `flickcli` 的 AI 命令行工具套了一个 Web UI。

**技术栈：**
- 前端：React 19 + TypeScript + Tailwind CSS v4 + Vite
- 后端：Express.js + TypeScript + ssh2
- 无数据库，任务数据存储在 `/tmp/kwaicli-tasks/` 的 JSON 文件里

---

## 项目架构（核心思路）

```
用户在浏览器输入消息
    ↓
POST /api/chat（后端创建任务，入队）
    ↓
TaskQueue 调度执行 → 调用 flickcli 命令行（本地或SSH）
    ↓
前端每秒轮询 GET /api/task/:id 拿结果
    ↓
把结果渲染成聊天气泡显示出来
```

---

## 一、后端核心代码逐行讲解

### 1. `server/src/index.ts` — 入口文件

```ts
const app = express();
const PORT = parseInt(process.env.PORT || "3001");

app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "10mb" }));

app.use("/api/chat", chatRouter);         // 创建任务
app.use("/api/tasks", tasksRouter);       // 查询所有任务
app.use("/api/task", taskRouter);         // 查询/取消单个任务
app.use("/api/sessions", sessionsRouter); // 会话历史
app.use("/api/projects", projectsRouter); // 项目目录
app.use("/api/models", modelsRouter);     // 可用模型列表
```

就是一个标准的 Express 服务，监听 3001 端口，注册了各个路由模块。

---

### 2. `server/src/routes/chat.ts` — 创建任务接口

```ts
router.post("/", async (req, res) => {
  const { message, sessionId, cwd, model, ...其他参数 } = req.body;

  // 防止同一 session 同时跑两个任务
  if (sessionId) {
    const allTasks = await taskManager.listTasks();
    const activeTask = allTasks.find(t =>
      t.sessionId === sessionId &&
      (t.status === "pending" || t.status === "running")
    );
    if (activeTask) return res.status(409).json({ error: "...", activeTaskId: activeTask.id });
  }

  // 创建任务对象，写入文件
  const task = await taskManager.createTask({ sessionId, project: cwd, message, model, ... });

  // 入队等待执行
  await taskQueue.enqueue(task.id);

  return res.json({ taskId: task.id });
});
```

**要点：**
- 创建任务后立即返回 `taskId`，前端用这个 ID 去轮询
- 有并发保护：同一个 session 不能同时跑两个任务（返回 409 状态码）

---

### 3. `server/src/lib/task-manager.ts` — 任务管理器（持久化）

这是一个**单例类**，负责把任务状态存到文件系统：

```ts
class TaskManager {
  private tasksDir = "/tmp/kwaicli-tasks";  // 任务存放目录

  // 创建任务 → 生成 ID → 写入 JSON 文件
  async createTask(params) {
    const taskId = `task-${Date.now()}-${随机字符串}`;
    const task = { id: taskId, status: "pending", output: [], createdAt: Date.now(), ... };
    await fs.writeFile(`/tmp/kwaicli-tasks/${taskId}.json`, JSON.stringify(task));
    return task;
  }

  // 读取任务
  async getTask(taskId) {
    const data = await fs.readFile(`${taskId}.json`, "utf-8");
    return JSON.parse(data);
  }

  // 更新任务（合并字段后重新写文件）
  async updateTask(taskId, updates) {
    const task = await this.getTask(taskId);
    Object.assign(task, updates);
    await this.saveTask(task);
  }

  // 追加输出事件（AI 的每条消息）
  async appendOutput(taskId, event) {
    const task = await this.getTask(taskId);
    task.output.push(event);
    await this.saveTask(task);
  }
}
```

**设计亮点：** 用文件系统做持久化，服务重启后任务状态不会丢失。

---

### 4. `server/src/lib/task-queue.ts` — 任务队列（调度器）

这是整个项目最核心的模块：

```ts
class TaskQueue {
  private queue: string[] = [];        // 等待执行的任务 ID 列表
  private running = new Set<string>(); // 正在执行的任务 ID 集合
  private maxConcurrent = 3;           // 最多同时跑 3 个任务
```

**初始化时：**
```ts
private async init() {
  await this.loadQueue();    // 从 queue.json 恢复队列（服务重启时恢复未完成任务）
  this.startProcessing();    // 启动每秒一次的轮询处理
}
```

**队列处理循环（每秒执行一次）：**
```ts
private async processQueue() {
  // 只要没达到并发上限，且队列不为空，就取出任务执行
  while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
    const taskId = this.queue.shift();  // 从队列头部取出
    this.running.add(taskId);
    this.executeTask(taskId);  // 异步执行，不 await（不阻塞后续任务）
  }
}
```

**执行单个任务：**
```ts
private async executeTask(taskId) {
  await taskManager.updateTask(taskId, { status: "running" });

  await this.runFlickcli(taskId);  // 调用 flickcli CLI 工具

  await taskManager.updateTask(taskId, { status: "completed" });
}
```

**取消任务：**
```ts
async cancelTask(taskId) {
  // 1. 如果还在队列里，直接移除
  const idx = this.queue.indexOf(taskId);
  if (idx !== -1) { this.queue.splice(idx, 1); }

  // 2. 如果正在执行，标记取消请求 + 发 SIGTERM 杀进程
  if (this.running.has(taskId)) {
    await taskManager.updateTask(taskId, { cancellationRequested: true });
    await stopProcess(task.processInfo);  // 杀掉 flickcli 进程
  }
}
```

---

### 5. `server/src/lib/ssh-bridge.ts` — 执行 flickcli（最底层）

这个文件负责真正执行 `flickcli` 命令，支持两种模式：

**检测本地还是远程：**
```ts
function detectLocalFlickcli(): boolean {
  // 检测 flickcli 是否在本机安装
  if (existsSync("/usr/local/bin/flickcli")) return true;
  execSync("which flickcli")  // 用 which 检测
}
const IS_LOCAL = detectLocalFlickcli();
```

**核心执行函数（异步生成器）：**
```ts
export async function* executeFlickcli(message, opts) {
  // 拼接命令行参数
  const args = ["-q", "--output-format", "stream-json"];
  if (opts.sessionId) args.push("-r", opts.sessionId);  // 恢复会话
  if (opts.model) args.push("-m", opts.model);           // 指定模型
  // ... 更多参数

  const command = `flickcli ${args.join(" ")}`;

  if (IS_LOCAL) {
    // 本地执行：用 child_process.spawn 启动进程
    const child = spawn("bash", ["-c", command]);

    child.stdout.on("data", (data) => {
      // flickcli 输出的每一行都是一个 JSON 事件
      const parts = buffer.split("\n");
      for (const part of parts) {
        enqueue({ type: "event", event: JSON.parse(part) });
      }
    });
  } else {
    // 远程执行：通过 SSH 连接到远程机器执行
    const conn = new Client();  // ssh2 的 SSH 客户端
    conn.connect(SSH_CONFIG);
    conn.exec(command, (err, stream) => { ... });
  }

  // 用异步生成器逐个 yield 事件
  while (true) {
    const item = await dequeue();
    if (item.type === "done") return;
    yield item.event;  // 把每个 AI 输出事件传给调用方
  }
}
```

**关键设计：** 用了一个 `enqueue/dequeue` 的消息队列桥接 Node.js 的事件流和 async generator，这样 task-queue.ts 可以用 `for await` 优雅地消费事件。

---

## 二、前端核心代码逐行讲解

### 1. `client/src/App.tsx` — 根组件（全局状态管理）

```ts
// 从 localStorage 读取上次保存的状态（刷新后不丢失）
function loadSaved<T>(key: string, fallback: T): T {
  const v = localStorage.getItem(key);
  return v !== null ? JSON.parse(v) : fallback;
}

export default function App() {
  const [viewMode, setViewMode] = useState<"tasks" | "chat">(() => {
    const savedSession = loadSaved("kwaicli_session", null);
    return savedSession ? "chat" : "tasks";  // 有历史会话就直接进聊天界面
  });

  const [selectedProject, setSelectedProject] = useState(() => loadSaved("kwaicli_project", ""));
  const [selectedSession, setSelectedSession] = useState(() => loadSaved("kwaicli_session", null));
  const [model, setModel] = useState(() => loadSaved("kwaicli_model", "claude-4.5-sonnet"));

  // 页面加载时请求项目列表
  useEffect(() => {
    fetch(`${BASE_PATH}/api/projects?tree=true`)
      .then(r => r.json())
      .then(data => {
        setTreeData(data.tree);          // 给侧边栏树状展示用
        setProjects(flattenTree(data.tree)); // 展平成列表供向后兼容
      });

    // 并行加载可用模型列表
    fetch(`${BASE_PATH}/api/models`).then(...);
  }, []);

  // 用 chatKey 强制重新挂载 ChatPanel（切换会话/项目时清空聊天记录）
  const remountChat = useCallback(() => {
    mountCounter.current += 1;
    setChatKey(`mount-${mountCounter.current}`);
  }, []);

  return (
    <main>
      <Sidebar ... />  {/* 左侧边栏：项目列表 + 会话历史 */}

      {viewMode === "tasks"
        ? <TaskList ... />            // 任务列表页
        : <ChatPanel key={chatKey} ... />  // 聊天页，key 变化时强制重新挂载
      }

      {configModal && <ConfigModal ... />}  {/* 配置弹窗 */}
    </main>
  );
}
```

---

### 2. `client/src/components/ChatPanel.tsx` — 聊天面板（最复杂的组件）

#### 发送消息流程

```ts
const handleSubmit = async () => {
  // 1. 先检查该 session 是否已有任务在跑
  const checkRes = await fetch(`/api/tasks?sessionId=${sessionId}`);
  if (有任务在跑) { alert("请等待..."); return; }

  // 2. 把用户消息加到界面
  setMessages(prev => [...prev, { role: "user", content: trimmed }]);
  setIsLoading(true);

  // 3. POST /api/chat 创建任务
  const res = await fetch("/api/chat", { method: "POST", body: JSON.stringify({...}) });
  const { taskId } = await res.json();

  // 4. 开始每秒轮询任务状态
  startPolling(taskId);
};
```

#### 轮询机制

```ts
const startPolling = useCallback((taskId: string) => {
  const pollTask = async () => {
    const res = await fetch(`/api/task/${taskId}`);
    const { status, output } = await res.json();

    // 增量处理：只处理新增的事件（lastOutputIndexRef 记录已处理到哪里）
    const newEvents = output.slice(lastOutputIndexRef.current);
    lastOutputIndexRef.current = output.length;

    for (const event of newEvents) {
      processEvent(event, setMessages, ...);  // 把每个事件转成聊天消息
    }

    if (status === "completed") {
      clearInterval(pollIntervalRef.current);
      setIsLoading(false);
    }
  };

  pollTask();  // 立即执行一次
  pollIntervalRef.current = setInterval(pollTask, 1000);  // 之后每秒一次
}, [...]);
```

#### 事件处理（processEvent 函数）

flickcli 输出的是结构化 JSON 事件，需要转换成聊天消息：

```ts
function processEvent(event, setMessages, onSession, setSessionInfo, pendingToolCalls) {
  // 1. meta 事件：把执行的命令附加到用户消息上（可展开查看）
  if (event.type === "meta") {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      return [...prev.slice(0,-1), { ...last, command: event.command }];
    });
  }

  // 2. system/init 事件：保存 sessionId 和模型信息
  if (event.type === "system") {
    onSession(event.sessionId);
    setSessionInfo({ model: event.model, tools: event.tools });
  }

  // 3. message/assistant 事件：AI 的回复
  if (event.type === "message" && event.role === "assistant") {
    for (const item of event.content) {
      if (item.type === "text") textContent = item.text;
      if (item.type === "tool_use") {
        // AI 调用工具（比如读文件、执行代码）
        pendingToolCalls.set(item.id, { name: item.name, input: item.input });
        toolCalls.push({ id, name, input });
      }
    }
    setMessages(prev => [...prev, { role: "assistant", content: textContent, toolCalls }]);
  }

  // 4. message/tool 事件：工具调用结果
  if (event.type === "message" && event.role === "tool") {
    // 把结果填回对应的工具调用卡片
    setMessages(prev => prev.map(msg => {
      const updated = msg.toolCalls?.map(tc =>
        tc.id === toolCallId ? { ...tc, result: returnDisplay } : tc
      );
      return { ...msg, toolCalls: updated };
    }));
  }
}
```

#### 页面刷新后任务恢复

```ts
useEffect(() => {
  // 1. 先从 sessionStorage 找上次的 taskId
  const savedTaskId = sessionStorage.getItem("kwaicli_currentTaskId");
  if (savedTaskId) {
    // 查后端这个任务是否还在跑
    fetch(`/api/task/${savedTaskId}`).then(data => {
      if (data.status === "pending" || data.status === "running") {
        setIsLoading(true);
        startPolling(savedTaskId);  // 继续轮询
      }
    });
    return;
  }

  // 2. 检查服务端是否有该 session 的活跃任务
  fetch(`/api/tasks?sessionId=${sessionId}`).then(data => {
    const runningTask = data.tasks.find(t => t.status === "running");
    if (runningTask) startPolling(runningTask.id);
  });
}, []);
```

---

### 3. `client/src/lib/types.ts` — 类型定义

这个文件定义了所有重要的数据结构：

```ts
// flickcli 输出的事件类型
type FlickcliEvent =
  | FlickcliInitEvent    // 会话初始化，包含 sessionId、模型名
  | FlickcliMessageEvent // AI 的消息（文本或工具调用）
  | FlickcliResultEvent  // 最终结果
  | FlickcliMetaEvent;   // 执行的命令字符串

// 任务状态机
type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelling" | "cancelled";

// 聊天消息（前端展示用）
interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id, name, input, result? }>;  // AI 调用的工具
  command?: string;  // 对应的 flickcli 命令
}

// 聊天模式
type ChatMode = "agent" | "plan" | "ask";
// agent: 全功能，可读写执行
// plan: 只读，输出实现计划
// ask: 纯对话，不改代码
```

---

## 三、数据流总结

```
用户输入
  → handleSubmit
    → POST /api/chat → chatRouter → taskManager.createTask → taskQueue.enqueue
  → startPolling(taskId)
    ↓ 每秒
    GET /api/task/:id
      ↓ 后台同时
      taskQueue.processQueue
        → executeTask → runFlickcli
          → ssh-bridge.executeFlickcli
            → spawn("flickcli ...")
              → 逐行读取 JSON 输出
                → taskManager.appendOutput(event)
    ← { status, output[] }
  → processEvent(新增事件)
    → setMessages(更新聊天界面)
  → status === "completed" → 停止轮询
```

---

## 四、面试可能会问的亮点

1. **为什么用轮询而不用 WebSocket/SSE？**
   - 轮询实现简单，不需要维护长连接状态，页面刷新后可以无缝恢复（只要知道 taskId 就能继续拿结果）

2. **任务持久化怎么做的？**
   - 每个任务存一个 JSON 文件在 `/tmp/kwaicli-tasks/`，服务重启后也能恢复

3. **怎么支持 SSH 远程执行的？**
   - 用 `ssh2` 库，检测本地没有 flickcli 时自动走 SSH 连接到远程机器执行

4. **async generator 在这里怎么用的？**
   - `executeFlickcli` 是一个 `async function*`，把 flickcli 的 stdout 流包装成异步迭代器，task-queue 用 `for await` 消费

5. **任务取消是怎么实现的？**
   - 设置 `cancellationRequested: true` 标志位，后台检测到后发 `SIGTERM` 给子进程；SSH 模式下直接关闭 SSH 连接让远程进程自动退出
