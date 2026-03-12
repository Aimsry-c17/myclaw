import express from "express";
import cors from "cors";
import chatRouter from "./routes/chat";
import tasksRouter from "./routes/tasks";
import taskRouter from "./routes/task";
import sessionsRouter from "./routes/sessions";
import projectsRouter from "./routes/projects";
import modelsRouter from "./routes/models";
import configRouter from "./routes/config";
import copilotRouter from "./routes/copilotkit";

const app = express();
const PORT = parseInt(process.env.PORT || "3001");

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api/chat", chatRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api/task", taskRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/models", modelsRouter);
app.use("/api/config", configRouter);
app.use("/api/copilotkit", copilotRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  console.log(`[Server] Mode: ${process.env.FLICKCLI_MODE || "auto"}`);
  console.log(`[Server] SSH Home: ${process.env.FLICKCLI_SSH_HOME || "not set"}`);
});

export default app;
