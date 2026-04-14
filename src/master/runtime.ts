// Auto-generated
import {
  createSdkMcpServer,
  query,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { settings, getConfiguredModel } from "../config";
import { decisionEngine } from "./decision";
import type {
  Config,
  HistoryEntry,
  MasterRuntimeMode,
  MasterState,
  Question,
  SlaveInfo,
  Task,
} from "../types";

export interface MasterRuntimeContext {
  triggerReason: string;
  timestamp: string;
  mission: string;
  config: Config;
  masterState: MasterState;
  tasks: Task[];
  slaves: SlaveInfo[];
  recentHistory: HistoryEntry[];
}

export interface MasterSnapshot {
  mission: string;
  runtimeMode: MasterRuntimeMode;
  currentPhase: string;
  turnStatus: MasterState["turnStatus"];
  activeSlaves: number;
  maxConcurrency: number;
  pendingCount: number;
  pendingQuestions: Question[];
  lastHeartbeat: string;
  lastDecisionAt: string;
  skippedWakeups: number;
  lastSkippedTriggerReason?: string;
  runtimeSessionSummary?: string;
}

export interface MasterRuntimeTurnResult {
  summary: string;
  toolCalls: string[];
  unauthorizedToolCalls: string[];
  sessionSummary?: string;
}

export interface WorkerAssignmentResult {
  status: "started" | "noop" | "not_found";
  taskId: string;
  message: string;
}

export interface ReviewerAssignmentResult {
  status: "started" | "approved" | "noop" | "not_found";
  taskId: string;
  message: string;
}

export interface MergeTaskResult {
  status: "merged" | "noop" | "failed" | "not_found";
  taskId: string;
  message: string;
}

export interface CleanupArtifactsResult {
  taskId: string;
  removedWorktree: boolean;
  removedBranch: boolean;
}

export interface MasterTools {
  get_master_snapshot(): Promise<MasterSnapshot>;
  list_tasks(input?: {
    status?: Task["status"] | Task["status"][];
  }): Promise<Task[]>;
  list_slaves(): Promise<SlaveInfo[]>;
  get_task(input: { taskId: string }): Promise<Task | null>;
  get_recent_history(input?: { limit?: number }): Promise<HistoryEntry[]>;
  get_task_diff(input: { taskId?: string; branch?: string }): Promise<string>;
  launch_inspector(input: {
    reason: string;
  }): Promise<{
    status: "started" | "noop";
    createdTaskIds: string[];
    message: string;
  }>;
  assign_worker(input: {
    taskId: string;
    additionalContext?: string;
  }): Promise<WorkerAssignmentResult>;
  assign_reviewer(input: { taskId: string }): Promise<ReviewerAssignmentResult>;
  create_task(input: {
    description: string;
    type?: Task["type"];
    priority?: number;
    context?: string;
  }): Promise<Task>;
  update_task(input: {
    taskId: string;
    patch: Partial<Task>;
  }): Promise<Task | null>;
  cancel_task(input: {
    taskId: string;
  }): Promise<{ status: "cancelled" | "noop"; taskId: string }>;
  retry_task(input: {
    taskId: string;
    additionalContext?: string;
  }): Promise<{ status: "retried" | "noop" | "not_found"; taskId: string }>;
  merge_task(input: { taskId: string }): Promise<MergeTaskResult>;
  cleanup_task_artifacts(input: {
    taskId: string;
  }): Promise<CleanupArtifactsResult>;
  ask_human(input: { question: string; options?: string[] }): Promise<Question>;
}

export interface MasterRuntime {
  init(context: MasterRuntimeContext, tools: MasterTools): Promise<void>;
  runTurn(
    context: MasterRuntimeContext,
    tools: MasterTools,
  ): Promise<MasterRuntimeTurnResult>;
  dispose(): Promise<void>;
  onExternalEvent?(event: {
    reason: string;
    timestamp: string;
  }): Promise<void> | void;
}

export type ClaudeMasterExecutor = (params: {
  context: MasterRuntimeContext;
  tools: MasterTools;
  sessionHints: string[];
  sessionId?: string;
  invokeTool: (name: keyof MasterTools, args?: unknown) => Promise<unknown>;
  allowedToolNames: Set<keyof MasterTools>;
}) => Promise<{ summary: string; sessionId?: string }>;

const TASK_STATUSES = [
  "pending",
  "assigned",
  "running",
  "completed",
  "failed",
  "reviewing",
  "approved",
  "rejected",
] as const;
const TASK_TYPES = [
  "fix",
  "feature",
  "refactor",
  "test",
  "docs",
  "other",
] as const;

export class MasterAgentAdapter {
  private readonly allowedTools = new Set<keyof MasterTools>([
    "get_master_snapshot",
    "list_tasks",
    "list_slaves",
    "get_task",
    "get_recent_history",
    "get_task_diff",
    "launch_inspector",
    "assign_worker",
    "assign_reviewer",
    "create_task",
    "update_task",
    "cancel_task",
    "retry_task",
    "merge_task",
    "cleanup_task_artifacts",
    "ask_human",
  ]);

  constructor(
    private readonly executor: ClaudeMasterExecutor = executeClaudeMasterTurn,
  ) {}

  async callTool(
    name: string,
    args: unknown,
    tools: MasterTools,
  ): Promise<unknown> {
    if (!this.allowedTools.has(name as keyof MasterTools)) {
      throw new Error(`Unauthorized master tool: ${name}`);
    }

    const toolFn = tools[name as keyof MasterTools] as
      | ((input?: unknown) => Promise<unknown>)
      | undefined;
    if (!toolFn) {
      throw new Error(`Unknown master tool: ${name}`);
    }

    return toolFn(args);
  }

  async run(
    context: MasterRuntimeContext,
    tools: MasterTools,
    sessionHints: string[] = [],
    sessionId?: string,
  ): Promise<MasterRuntimeTurnResult & { sessionId?: string }> {
    const toolCalls: string[] = [];
    const unauthorizedToolCalls: string[] = [];

    const invokeTool = async (
      name: keyof MasterTools,
      args?: unknown,
    ): Promise<unknown> => {
      try {
        const result = await this.callTool(name, args, tools);
        toolCalls.push(name);
        return result;
      } catch (error) {
        if ((error as Error).message.startsWith("Unauthorized master tool:")) {
          unauthorizedToolCalls.push(name);
        }
        throw error;
      }
    };

    const result = await this.executor({
      context,
      tools,
      sessionHints,
      sessionId,
      invokeTool,
      allowedToolNames: this.allowedTools,
    });

    return {
      summary: result.summary,
      toolCalls,
      unauthorizedToolCalls,
      sessionSummary: buildSessionSummary(context, toolCalls, sessionHints),
      sessionId: result.sessionId,
    };
  }
}

class HeartbeatAgentRuntime implements MasterRuntime {
  private readonly adapter: MasterAgentAdapter;
  private readonly fallbackRuntime: HybridMasterRuntime;

  constructor(adapter?: MasterAgentAdapter) {
    this.adapter = adapter || new MasterAgentAdapter();
    this.fallbackRuntime = new HybridMasterRuntime();
  }

  async init(
    _context: MasterRuntimeContext,
    _tools: MasterTools,
  ): Promise<void> {}

  async runTurn(
    context: MasterRuntimeContext,
    tools: MasterTools,
  ): Promise<MasterRuntimeTurnResult> {
    try {
      const result = await this.adapter.run(context, tools);
      if (result.toolCalls.length > 0) {
        return {
          summary: result.summary,
          toolCalls: result.toolCalls,
          unauthorizedToolCalls: result.unauthorizedToolCalls,
          sessionSummary: result.sessionSummary,
        };
      }

      const fallback = await this.fallbackRuntime.runTurn(context, tools);
      return {
        summary: `${result.summary}\nFallback: ${fallback.summary}`,
        toolCalls: fallback.toolCalls,
        unauthorizedToolCalls: [
          ...result.unauthorizedToolCalls,
          ...fallback.unauthorizedToolCalls,
        ],
        sessionSummary: result.sessionSummary,
      };
    } catch (error) {
      const fallback = await this.fallbackRuntime.runTurn(context, tools);
      return {
        summary: `Adapter failed: ${(error as Error).message}\nFallback: ${fallback.summary}`,
        toolCalls: fallback.toolCalls,
        unauthorizedToolCalls: fallback.unauthorizedToolCalls,
      };
    }
  }

  async dispose(): Promise<void> {}
}

class SessionAgentRuntime implements MasterRuntime {
  private readonly adapter: MasterAgentAdapter;
  private sessionHints: string[] = [];
  private sessionId?: string;

  constructor(adapter?: MasterAgentAdapter, initialSummary?: string) {
    this.adapter = adapter || new MasterAgentAdapter();
    if (initialSummary) {
      this.sessionHints.push(initialSummary);
    }
  }

  async init(
    _context: MasterRuntimeContext,
    _tools: MasterTools,
  ): Promise<void> {}

  async onExternalEvent(event: {
    reason: string;
    timestamp: string;
  }): Promise<void> {
    this.sessionHints.push(`${event.timestamp}:${event.reason}`);
    this.sessionHints = this.sessionHints.slice(-20);
  }

  async runTurn(
    context: MasterRuntimeContext,
    tools: MasterTools,
  ): Promise<MasterRuntimeTurnResult> {
    const result = await this.adapter.run(
      context,
      tools,
      this.sessionHints,
      this.sessionId,
    );
    this.sessionId = result.sessionId || this.sessionId;
    this.sessionHints.push(result.summary);
    this.sessionHints = this.sessionHints.slice(-20);

    return {
      summary: result.summary,
      toolCalls: result.toolCalls,
      unauthorizedToolCalls: result.unauthorizedToolCalls,
      sessionSummary: this.sessionHints.join("\n"),
    };
  }

  async dispose(): Promise<void> {
    this.sessionHints = [];
    this.sessionId = undefined;
  }
}

class HybridMasterRuntime implements MasterRuntime {
  async init(
    _context: MasterRuntimeContext,
    _tools: MasterTools,
  ): Promise<void> {}

  async runTurn(
    context: MasterRuntimeContext,
    tools: MasterTools,
  ): Promise<MasterRuntimeTurnResult> {
    const toolCalls: string[] = [];
    const unauthorizedToolCalls: string[] = [];

    const snapshot = await tools.get_master_snapshot();
    toolCalls.push("get_master_snapshot");
    const unansweredQuestions = snapshot.pendingQuestions.filter(
      (q) => !q.answered,
    );
    const pendingQuestionTexts = unansweredQuestions.map((q) => q.question);

    const decision = await decisionEngine.decide({
      mission: context.mission,
      recentHistory: context.recentHistory,
      currentTasks: context.tasks,
      pendingQuestions: pendingQuestionTexts,
    });

    if (decision.action === "ask_human" && decision.data?.question) {
      await tools.ask_human({
        question: decision.data.question,
        options: decision.data.options || [],
      });
      toolCalls.push("ask_human");
    }

    if (decision.action === "pause") {
      return {
        summary: `Hybrid runtime paused: ${decision.reason}`,
        toolCalls,
        unauthorizedToolCalls,
      };
    }

    let activeSlaves = snapshot.activeSlaves;
    const reviewingTasks = decisionEngine.prioritizeTasks(
      context.tasks.filter((task) => task.status === "reviewing").slice(),
    );
    for (const task of reviewingTasks) {
      if (activeSlaves >= context.config.maxConcurrency) break;
      const result = await tools.assign_reviewer({ taskId: task.id });
      toolCalls.push("assign_reviewer");
      if (result.status === "started") {
        activeSlaves++;
      }
    }

    const approvedTasks = context.tasks.filter(
      (task) => task.status === "approved",
    );
    for (const task of approvedTasks) {
      await tools.merge_task({ taskId: task.id });
      toolCalls.push("merge_task");
    }

    const pendingTasks = decisionEngine.prioritizeTasks(
      context.tasks.filter((task) => task.status === "pending").slice(),
    );
    for (const task of pendingTasks) {
      if (activeSlaves >= context.config.maxConcurrency) break;
      const result = await tools.assign_worker({ taskId: task.id });
      toolCalls.push("assign_worker");
      if (result.status === "started") {
        activeSlaves++;
      }
    }

    const activeTasks = context.tasks.filter((task) =>
      ["pending", "assigned", "running", "reviewing", "approved"].includes(
        task.status,
      ),
    );
    if (
      activeTasks.length === 0 &&
      decisionEngine.shouldInspect({
        mission: context.mission,
        recentHistory: context.recentHistory,
        currentTasks: context.tasks,
        pendingQuestions: pendingQuestionTexts,
      })
    ) {
      await tools.launch_inspector({
        reason: `trigger=${context.triggerReason}`,
      });
      toolCalls.push("launch_inspector");
    }

    return {
      summary:
        unansweredQuestions.length > 0
          ? `Hybrid runtime completed one orchestration turn with ${unansweredQuestions.length} pending question(s)`
          : "Hybrid runtime completed one orchestration turn",
      toolCalls,
      unauthorizedToolCalls,
    };
  }

  async dispose(): Promise<void> {}
}

export function createMasterRuntime(
  mode: MasterRuntimeMode,
  config: Config,
  state: MasterState,
  options?: { agentExecutor?: ClaudeMasterExecutor },
): MasterRuntime {
  const adapter = options?.agentExecutor
    ? new MasterAgentAdapter(options.agentExecutor)
    : undefined;

  if (mode === "heartbeat_agent") {
    return new HeartbeatAgentRuntime(adapter);
  }
  if (mode === "session_agent") {
    return new SessionAgentRuntime(adapter, state.runtimeSessionSummary);
  }
  return new HybridMasterRuntime();
}

async function executeClaudeMasterTurn(params: {
  context: MasterRuntimeContext;
  tools: MasterTools;
  sessionHints: string[];
  sessionId?: string;
  invokeTool: (name: keyof MasterTools, args?: unknown) => Promise<unknown>;
  allowedToolNames: Set<keyof MasterTools>;
}): Promise<{ summary: string; sessionId?: string }> {
  const { context, sessionHints, sessionId, invokeTool, allowedToolNames } =
    params;
  const mcpServerName = "master_tools";
  const mcpServer = createSdkMcpServer({
    name: mcpServerName,
    tools: buildMasterSdkTools(invokeTool),
  });

  const model = getConfiguredModel(context.config, "master");
  const prompt = buildMasterPrompt(context, sessionHints);
  const sdkEnv = buildMasterSdkEnv(context.config);
  const allowedSimpleNames = new Set([...allowedToolNames]);

  const stream = query({
    prompt,
    options: {
      cwd: process.cwd(),
      env: sdkEnv,
      ...(model ? { model } : {}),
      maxTurns: 8,
      tools: [],
      mcpServers: {
        [mcpServerName]: mcpServer,
      },
      permissionMode: "dontAsk",
      systemPrompt: buildMasterSystemPrompt(),
      persistSession: true,
      ...(sessionId ? { resume: sessionId } : {}),
      canUseTool: async (toolName) => {
        const normalized = normalizeMasterToolName(toolName);
        if (allowedSimpleNames.has(normalized as keyof MasterTools)) {
          return { behavior: "allow" };
        }
        return {
          behavior: "deny",
          message: "Only MasterTools are available to the master agent.",
        };
      },
    },
  });

  let resultText = "";
  let resolvedSessionId = sessionId;
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init") {
      resolvedSessionId = message.session_id;
      continue;
    }
    if (message.type === "result") {
      if (message.subtype === "success") {
        resultText = message.result;
      } else {
        const errorText =
          (message as any).errors?.join("; ") ||
          "Unknown Claude Agent SDK error";
        throw new Error(errorText);
      }
    }
  }

  return {
    summary: resultText || "Claude master turn completed",
    sessionId: resolvedSessionId,
  };
}

function buildMasterSdkTools(
  invokeTool: (name: keyof MasterTools, args?: unknown) => Promise<unknown>,
) {
  return [
    tool(
      "get_master_snapshot",
      "Get current master runtime snapshot.",
      {},
      async () => asToolResult(await invokeTool("get_master_snapshot")),
    ),
    tool(
      "list_tasks",
      "List tasks, optionally filtering by status or statuses.",
      {
        status: z
          .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))])
          .optional(),
      },
      async (args) => asToolResult(await invokeTool("list_tasks", args)),
    ),
    tool("list_slaves", "List all slaves and their states.", {}, async () =>
      asToolResult(await invokeTool("list_slaves")),
    ),
    tool(
      "get_task",
      "Get a single task by id.",
      { taskId: z.string() },
      async (args) => asToolResult(await invokeTool("get_task", args)),
    ),
    tool(
      "get_recent_history",
      "Get recent history entries.",
      { limit: z.number().int().positive().optional() },
      async (args) =>
        asToolResult(await invokeTool("get_recent_history", args)),
    ),
    tool(
      "get_task_diff",
      "Get diff for a task or branch.",
      {
        taskId: z.string().optional(),
        branch: z.string().optional(),
      },
      async (args) => asToolResult(await invokeTool("get_task_diff", args)),
    ),
    tool(
      "launch_inspector",
      "Launch inspector to discover new tasks.",
      { reason: z.string() },
      async (args) => asToolResult(await invokeTool("launch_inspector", args)),
    ),
    tool(
      "assign_worker",
      "Assign a worker to a pending task.",
      {
        taskId: z.string(),
        additionalContext: z.string().optional(),
      },
      async (args) => asToolResult(await invokeTool("assign_worker", args)),
    ),
    tool(
      "assign_reviewer",
      "Assign a reviewer to a reviewing task.",
      { taskId: z.string() },
      async (args) => asToolResult(await invokeTool("assign_reviewer", args)),
    ),
    tool(
      "create_task",
      "Create a new task for the backlog.",
      {
        description: z.string(),
        type: z.enum(TASK_TYPES).optional(),
        priority: z.number().int().min(1).max(10).optional(),
        context: z.string().optional(),
      },
      async (args) => asToolResult(await invokeTool("create_task", args)),
    ),
    tool(
      "update_task",
      "Update a task with a partial patch.",
      {
        taskId: z.string(),
        patch: z.record(z.string(), z.any()),
      },
      async (args) => asToolResult(await invokeTool("update_task", args)),
    ),
    tool(
      "cancel_task",
      "Cancel a task.",
      { taskId: z.string() },
      async (args) => asToolResult(await invokeTool("cancel_task", args)),
    ),
    tool(
      "retry_task",
      "Retry a failed or rejected task.",
      {
        taskId: z.string(),
        additionalContext: z.string().optional(),
      },
      async (args) => asToolResult(await invokeTool("retry_task", args)),
    ),
    tool(
      "merge_task",
      "Merge an approved task into the develop branch.",
      { taskId: z.string() },
      async (args) => asToolResult(await invokeTool("merge_task", args)),
    ),
    tool(
      "cleanup_task_artifacts",
      "Clean up branch and worktree artifacts for a task.",
      { taskId: z.string() },
      async (args) =>
        asToolResult(await invokeTool("cleanup_task_artifacts", args)),
    ),
    tool(
      "ask_human",
      "Ask a human question and persist it for later answer.",
      {
        question: z.string(),
        options: z.array(z.string()).optional(),
      },
      async (args) => asToolResult(await invokeTool("ask_human", args)),
    ),
  ];
}

function asToolResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function buildMasterSdkEnv(config: Config): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...(process.env as Record<string, string | undefined>),
  };
  delete env.API_KEY;
  delete env.BASE_URL;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  return {
    ...env,
    ANTHROPIC_API_KEY: config.provider.apiKey,
    ANTHROPIC_BASE_URL: config.provider.baseUrl,
  };
}

function buildMasterSystemPrompt(): string {
  return [
    "You are the master orchestration agent for this repository.",
    "You are not allowed to write code, run shell commands, read files directly, edit files, or use any coding tool.",
    "Only use the provided MasterTools MCP tools.",
    "Primary goals by priority:",
    "1. Move reviewing tasks forward.",
    "2. Merge approved tasks.",
    "3. Dispatch pending tasks within concurrency limits.",
    "4. If nothing is active, launch inspection to discover new work.",
    "5. Ask human only when blocked by ambiguity or repeated failure.",
    "Be concise and tool-driven.",
  ].join("\n");
}

function buildMasterPrompt(
  context: MasterRuntimeContext,
  sessionHints: string[],
): string {
  const pendingQuestions =
    context.masterState.pendingQuestions
      .filter((question) => !question.answered)
      .map((question) => `- [${question.id}] ${question.question}`)
      .join("\n") || "none";

  const tasksByStatus = groupTaskCounts(context.tasks);
  const taskSummary =
    Object.entries(tasksByStatus)
      .map(([status, count]) => `- ${status}: ${count}`)
      .join("\n") || "- none";

  const recentHistory =
    context.recentHistory
      .slice(-8)
      .map((entry) => `- ${entry.timestamp} ${entry.type}: ${entry.summary}`)
      .join("\n") || "- none";

  const hintBlock =
    sessionHints.length > 0
      ? sessionHints
          .slice(-8)
          .map((item) => `- ${item}`)
          .join("\n")
      : "- none";

  return [
    `Current time: ${context.timestamp}`,
    `Trigger reason: ${context.triggerReason}`,
    `Mission: ${context.mission}`,
    "",
    "Master state:",
    `- phase: ${context.masterState.currentPhase}`,
    `- turnStatus: ${context.masterState.turnStatus}`,
    `- skippedWakeups: ${context.masterState.skippedWakeups}`,
    "",
    "Task counts:",
    taskSummary,
    "",
    "Pending human questions:",
    pendingQuestions,
    "",
    "Recent history:",
    recentHistory,
    "",
    "Session hints:",
    hintBlock,
    "",
    "Use MasterTools only. Decide the next best orchestration actions and execute them.",
  ].join("\n");
}

function buildSessionSummary(
  context: MasterRuntimeContext,
  toolCalls: string[],
  sessionHints: string[],
): string {
  return [
    `mode=${context.config.master.runtimeMode}`,
    `trigger=${context.triggerReason}`,
    `tools=${toolCalls.join(",") || "none"}`,
    `hints=${sessionHints.slice(-3).join(" | ") || "none"}`,
  ].join("\n");
}

function groupTaskCounts(tasks: Task[]): Record<string, number> {
  return tasks.reduce<Record<string, number>>((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
}

function normalizeMasterToolName(toolName: string): string {
  return toolName
    .split(/__|[.:/]/)
    .filter(Boolean)
    .pop() || toolName;
}
