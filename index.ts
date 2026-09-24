import { ToolLoopAgent, stepCountIs, tool, pruneMessages } from "ai";
import { z } from "zod";
import { anthropic } from '@ai-sdk/anthropic';
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { buildSystemPrompt } from "./src/system";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import {
  createReadTool,
  createGrepTool,
  createBashTool,
  createTaskTool,
  createApproval,
  createAskUserTool,
  createTodoTool,
} from "./src/tools";
import type { SandboxLifecycle } from "./src/sandbox";
import { addCacheControl } from "./src/cache";

const cwd = process.argv[2] || process.cwd();

const createSandboxByEnv = async (cwd: string) => {
  const sandboxType = process.env.SANDBOX || "local";
  const sandbox =
    sandboxType === "just-bash"
      ? await createJustBashSandbox(cwd)
      : createLocalSandbox(cwd);
  return sandbox;
}

const sandbox = await createSandboxByEnv(cwd);
const lifecycle: SandboxLifecycle = {};
 
await lifecycle.afterStart?.(sandbox);

const tools = {
  read: createReadTool(sandbox),
  grep: createGrepTool(sandbox),
  bash: createBashTool(sandbox, createApproval({ mode: "interactive" })),
  askUser: createAskUserTool(),
  todo: createTodoTool(),
};

const tools_with_task = {
  ...tools,
  task: createTaskTool(sandbox, { read: tools.read, grep: tools.grep }),
};
 
const agentsPath = join(cwd, "AGENTS.md");
const projectContext = existsSync(agentsPath)
  ? readFileSync(agentsPath, "utf-8")
  : undefined;

const instructions = buildSystemPrompt({
  workingDirectory: cwd,
  sandboxType: "local",
  toolNames: Object.keys(tools),
  projectContext,
});

const agent = new ToolLoopAgent({
  // model: "anthropic/claude-haiku-4-5",
  model: anthropic("claude-haiku-4-5-20251001"),
  instructions,
  tools: tools_with_task,
  stopWhen: stepCountIs(10),
  onStepFinish: ({ usage, stepNumber }) => {
  console.error(
    `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output`
  );
},
  prepareCall: async (options) => {
    const pruned = options.messages
      ? pruneMessages({
          messages: options.messages,
          toolCalls: "before-last-3-messages",
        })
      : undefined;
  
    return {
      ...options,
      messages: pruned ? addCacheControl(pruned) : undefined,
    };
  },
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
try {
  const { text, steps } = await agent.generate({ prompt });
  console.log(text);
  console.log(`\n(${steps.length} steps)`);
} finally {
  await lifecycle.beforeStop?.(sandbox);
  await sandbox.stop();
}
