import { ToolLoopAgent, stepCountIs, tool, pruneMessages } from "ai";
import type { Sandbox } from "./sandbox";
import { z } from "zod";
import { resolve } from "node:path";
import { anthropic } from '@ai-sdk/anthropic';

const cwd = process.argv[2] || process.cwd();

export function createReadTool(sandbox: Sandbox) {
  return tool({
    description: `Read a file from the project. Returns numbered lines.
   
  WHEN TO USE: viewing file contents, checking configurations, reading source code,
    examining specific lines with offset/limit.
   
  WHEN NOT TO USE: searching for patterns across files (use grep instead).
    Running commands (use bash instead).
   
  DO NOT USE FOR: searching code (use grep), executing commands (use bash),
    modifying files (use edit or write).
   
  USAGE: path is relative to working directory. offset and limit are optional.
    Output is capped at 500 lines.`,
    inputSchema: z.object({
      path: z.string().describe("File path relative to working directory"),
      offset: z.number().optional().describe("Start line (1-indexed)"),
      limit: z.number().optional().describe("Max lines to return"),
    }),
    execute: async ({ path: filePath, offset, limit }) => {
      const content = await sandbox.readFile(filePath);
      let lines = content.split("\n");
   
      if (offset) lines = lines.slice(offset - 1);
      if (limit) lines = lines.slice(0, limit);
   
      const MAX_LINES = 500;
      const MAX_CHARS = 12000;
      const truncatedLines = lines.length > MAX_LINES;
      if (truncatedLines) lines = lines.slice(0, MAX_LINES);
   
      const numbered = lines.map((l, i) => `${(offset || 1) + i}: ${l}`);
      let output = truncatedLines
        ? numbered.join("\n") + `\n... (truncated at ${MAX_LINES} lines)`
        : numbered.join("\n");

      if (output.length > MAX_CHARS) {
        output = output.slice(0, MAX_CHARS) + `\n... (truncated at ${MAX_CHARS} characters)`;
      }

      return output;
    },
  });
}

const SAFE_PREFIXES = [
  "ls", "cat", "echo", "pwd", "which", "find",
  "head", "tail", "wc", "git log", "git status", "git diff",
];

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

export function createApproval(config: ApprovalConfig) {
  return ({ command }: { command: string }) => {
    if (config.mode === "background") return false;
 
    if (config.mode === "delegated") {
      return !config.trust.some((p) => command.trim().startsWith(p));
    }
 
    return !SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  };
}

export function createBashTool(
  sandbox: Sandbox,
  needsApproval: (input: { command: string }) => boolean,
) {
  const MAX_BASH_CHARS = 5000;

  return tool({
    description: `Execute a shell command in the working directory.
 
WHEN TO USE: running build commands, installing packages, running tests,
  git operations, directory listings.
 
WHEN NOT TO USE: reading file contents (use read instead).
  Searching for patterns (use grep instead).
 
DO NOT USE FOR: reading files (use read), searching code (use grep).
 
USAGE: command is a single shell string. Commands not in the safe-prefix
  allowlist are blocked and return a clear error message.`,
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
    }),
    execute: async ({ command }) => {
      if (needsApproval({ command })) {
        return `Blocked: "${command}" requires approval.`;
      }
      const result = await sandbox.exec(command);
      const stdout = result.stdout || "(no output)";
      return stdout.length > MAX_BASH_CHARS
        ? stdout.slice(-MAX_BASH_CHARS) +
            `\n... (truncated, showing last ${MAX_BASH_CHARS} chars)`
        : stdout || "(no output)";
    },
  });
}

export function createGrepTool(sandbox: Sandbox) {
  return tool({
    description: `Search file contents using regex. Returns matching lines with file paths.
   
  WHEN TO USE: finding patterns across multiple files, locating function definitions,
    searching for imports, finding TODOs or error messages.
   
  WHEN NOT TO USE: reading a known file (use read instead).
    Running commands (use bash instead).
   
  DO NOT USE FOR: reading files (use read), listing directories (use bash),
    modifying files (use edit).
   
  USAGE: pattern is a regex string. glob filters by file extension.
    Results are capped at 50 matches.
   
  EXAMPLES:
    - Find all TODO comments: pattern "TODO" glob "*.ts"
    - Find function definitions: pattern "function \\w+" glob "*.ts"
    - Find imports of a package: pattern "from 'express'" glob "*.ts"`,
    inputSchema: z.object({
      pattern: z.string().describe("Regex pattern to search for"),
      path: z.string().optional().describe("Directory to search (default: working dir)"),
      glob: z.string().optional().describe("File glob filter, e.g. '*.ts'"),
    }),
    execute: async ({ pattern, path: searchPath, glob: globFilter }) => {
      const dir = resolve(cwd, searchPath || ".");
      const escapedPattern = pattern.replace(/'/g, `'\\''`);
      const escapedGlob = (globFilter || "*").replace(/'/g, `'\\''`);
      const cmd = `grep -rn --exclude-dir=node_modules --exclude-dir=.git --include='${escapedGlob}' -E '${escapedPattern}' '${dir}' 2>/dev/null`;
   
      try {
        const { stdout } = await sandbox.exec(cmd);
        const lines = stdout.trim().split("\n").filter(Boolean);
   
        const MAX_MATCHES = 50;
        const truncated = lines.length > MAX_MATCHES;
        const result = truncated ? lines.slice(0, MAX_MATCHES) : lines;
   
        return truncated
          ? result.join("\n") + `\n... (${lines.length} total, showing first ${MAX_MATCHES})`
          : result.join("\n") || "No matches found.";
      } catch (error: any) {
        const stdout = String(error?.stdout || "").trim();
        if (stdout) {
          const lines = stdout.split("\n").filter(Boolean);
          const MAX_MATCHES = 50;
          const truncated = lines.length > MAX_MATCHES;
          const result = truncated ? lines.slice(0, MAX_MATCHES) : lines;
          return truncated
            ? result.join("\n") + `\n... (${lines.length} total, showing first ${MAX_MATCHES})`
            : result.join("\n");
        }
        return "No matches found.";
      }
    },
  });
}

function buildExplorer(sandbox: Sandbox, parentTools: { read: any; grep: any }) {
  return new ToolLoopAgent({
    model: anthropic("claude-haiku-4-5-20251001"),
    instructions: `You are an explorer agent. Investigate and report back concisely.
Working directory: ${sandbox.workingDirectory}`,
    tools: { read: parentTools.read, grep: parentTools.grep },
    stopWhen: stepCountIs(5),
    prepareCall: async (options) => ({
      ...options,
      messages: options.messages
        ? pruneMessages({
            messages: options.messages,
            toolCalls: "before-last-2-messages",
          })
        : undefined,
    }),
  });
}
 
function buildExecutor(sandbox: Sandbox, parentTools: { read: any; grep: any }) {
  const executorBash = createBashTool(
    sandbox,
    createApproval({
      mode: "delegated",
      trust: ["npm test", "npm run build", "npx tsc"],
    }),
  );
  return new ToolLoopAgent({
    model: anthropic('claude-sonnet-5'),
    instructions: `You are an executor agent. Follow instructions precisely.
Working directory: ${sandbox.workingDirectory}
Do NOT ask questions. Do NOT explore beyond what's needed. Execute the task.`,
    tools: { read: parentTools.read, grep: parentTools.grep, bash: executorBash },
    stopWhen: stepCountIs(15),
    prepareCall: async (options) => ({
      ...options,
      messages: options.messages
        ? pruneMessages({
            messages: options.messages,
            toolCalls: "before-last-2-messages",
          })
        : undefined,
    }),
  });
}
 
async function runSubagent(role: string, agent: ToolLoopAgent<never, any, any, any>, description: string) {
  try {
    const { text, steps } = await agent.generate({ prompt: description });
    const MAX_SUBAGENT_RETURN_CHARS = 4000;
    let output = text ? `[${role}: ${steps.length} steps]\n${text}` : `(no response from ${role})`;
    
    if (output.length > MAX_SUBAGENT_RETURN_CHARS) {
      output = output.slice(0, MAX_SUBAGENT_RETURN_CHARS) + `\n... (subagent output truncated)`;
    }
    return output;
  } catch (e: any) {
    return `${role} error: ${e.message}`;
  }
}
 
export function createTaskTool(
  sandbox: Sandbox,
  parentTools: { read: any; grep: any },
) {
  return tool({
    description: `Delegate work to a subagent.
Explorer (default): read-only research with Haiku. Use for searching across files,
  understanding patterns, and gathering context.
Executor: implementation with Sonnet and delegated bash. Use for focused
  changes with explicit instructions and a known verification step.
 
WHEN TO USE: research across many files (explorer), bulk implementation (executor).
WHEN NOT TO USE: ambiguous requirements (use askUser), architectural decisions
  (the parent decides).
DO NOT USE FOR: single-step tasks the parent can do directly.`,
    inputSchema: z.object({
      description: z.string().describe("Task instructions for the subagent"),
      subagentType: z
        .enum(["explorer", "executor"])
        .default("explorer")
        .describe("Subagent role"),
    }),
    execute: async ({ description, subagentType }) => {
      const agent =
        subagentType === "executor"
          ? buildExecutor(sandbox, parentTools)
          : buildExplorer(sandbox, parentTools);
      return runSubagent(subagentType, agent, description);
    },
  });
}
 
export function createAskUserTool() {
  return tool({
    description: `Ask the user a multiple-choice question.
WHEN TO USE: scoping ambiguous tasks, choosing between approaches,
  resolving a missing detail before acting.
WHEN NOT TO USE: you already have enough context to proceed.
DO NOT USE FOR: rhetorical questions or progress updates.`,
    inputSchema: z.object({
      question: z.string().describe("The question to ask the user"),
      options: z
        .array(z.string())
        .min(2)
        .max(4)
        .describe("Two to four options for the user to pick from"),
    }),
    execute: async ({ question, options }) => {
      const formatted = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
      console.log(`\nQuestion: ${question}\n${formatted}\n`);
      return `Asked: "${question}"\nOptions:\n${formatted}\n\n(Awaiting user response.)`;
    },
  });
}

interface TodoItem {
  id: string;
  description: string;
  state: "pending" | "in_progress" | "completed";
}
 
const todos: TodoItem[] = [];
 
export function createTodoTool() {
  return tool({
    description: `Manage a task list for multi-step work.
WHEN TO USE: tasks with 3+ steps, multiple files, or dependencies between
  changes. Plan once, then track progress as you go.
WHEN NOT TO USE: single-file fixes, simple questions, exploratory reads.
DO NOT USE FOR: status updates to the user (just answer them directly).`,
    inputSchema: z.object({
      action: z.enum(["add", "start", "complete", "list"]),
      description: z.string().optional(),
      id: z.string().optional(),
    }),
    execute: async ({ action, description, id }) => {
      if (action === "add") {
        const item: TodoItem = {
          id: crypto.randomUUID().slice(0, 8),
          description: description ?? "(unnamed)",
          state: "pending",
        };
        todos.push(item);
        return `Added: [${item.id}] ${item.description}`;
      }
 
      if (action === "start") {
        const active = todos.find((t) => t.state === "in_progress");
        if (active) {
          return `Already working on: [${active.id}] ${active.description}. Complete it first.`;
        }
        const next = todos.find((t) => t.id === id);
        if (next) {
          next.state = "in_progress";
          return `Started: [${next.id}] ${next.description}`;
        }
        return `No todo with id ${id}.`;
      }
 
      if (action === "complete") {
        const item = todos.find((t) => t.id === id);
        if (item) {
          item.state = "completed";
          return `Completed: [${item.id}] ${item.description}`;
        }
        return `No todo with id ${id}.`;
      }
 
      return todos
        .map((t) => `[${t.state}] ${t.id}: ${t.description}`)
        .join("\n") || "No todos.";
    },
  });
}