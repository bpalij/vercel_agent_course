import { parseArgs } from "node:util";
import { ToolLoopAgent, stepCountIs, pruneMessages } from "ai";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import { buildSystemPrompt } from "./src/system";
import {
  createReadTool,
  createGrepTool,
  createBashTool,
  createTaskTool,
  createAskUserTool,
  createTodoTool,
} from "./src/tools";
import { createApproval } from "./src/approval";
import { addCacheControl } from "./src/cache";
import { discoverGates } from "./src/verification";
import type { Sandbox } from "./src/sandbox";
import { anthropic } from '@ai-sdk/anthropic';
 
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    sandbox: { type: "string", default: "local" },
    model: { type: "string", default: "" },
  },
  allowPositionals: true,
});
 
const cwd = resolve(positionals[0] || process.cwd());
const prompt = positionals.slice(1).join(" ") || "Hello!";
 
async function sandboxFromFlag(name: string, dir: string): Promise<Sandbox> {
  if (name === "just-bash") return createJustBashSandbox(dir);
  return createLocalSandbox(dir);
}
 
const sandbox = await sandboxFromFlag(values.sandbox!, cwd);
console.error(`Sandbox: ${sandbox.type}`);
 
const projectContext = existsSync(join(cwd, "AGENTS.md"))
  ? readFileSync(join(cwd, "AGENTS.md"), "utf-8")
  : undefined;
 
const verificationCommands = await discoverGates(sandbox);
 
const baseTools = {
  read: createReadTool(sandbox),
  grep: createGrepTool(sandbox),
  bash: createBashTool(sandbox, createApproval({ mode: "interactive" })),
};
const tools = {
  ...baseTools,
  task: createTaskTool(sandbox, { read: baseTools.read, grep: baseTools.grep }),
  askUser: createAskUserTool(),
  todo: createTodoTool(),
};
 
const agent = new ToolLoopAgent({
  model: values.model || anthropic("claude-haiku-4-5-20251001"),
  instructions: buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: sandbox.type,
    toolNames: Object.keys(tools),
    projectContext,
    verificationCommands,
  }),
  tools,
  stopWhen: stepCountIs(15),
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
  onStepFinish: ({ usage, stepNumber }) => {
    console.error(
      `Step ${stepNumber}: ${usage.inputTokens} input, ${usage.outputTokens} output`,
    );
  },
});
 
process.on("SIGINT", async () => {
  console.error("\nShutting down...");
  await sandbox.stop();
  process.exit(0);
});
 
try {
  const { text, steps } = await agent.generate({ prompt });
  console.log(text);
  console.log(`\n(${steps.length} steps)`);
} finally {
  await sandbox.stop();
}