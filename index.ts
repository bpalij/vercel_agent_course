import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import { anthropic } from '@ai-sdk/anthropic';
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { buildSystemPrompt } from "./src/system";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSandbox } from "./src/sandbox-local";
import { createReadTool, createGrepTool, createBashTool } from "./src/tools";

const cwd = process.argv[2] || process.cwd();

const sandbox = createLocalSandbox(cwd);

const SAFE_PREFIXES = [
  "ls", "cat", "echo", "pwd", "which", "find",
  "head", "tail", "wc", "git log", "git status", "git diff",
];

type ApprovalConfig =
  | { mode: "interactive" }
  | { mode: "background" }
  | { mode: "delegated"; trust: string[] };

function createApproval(config: ApprovalConfig) {
  return ({ command }: { command: string }) => {
    if (config.mode === "background") return false;
 
    if (config.mode === "delegated") {
      return !config.trust.some((p) => command.trim().startsWith(p));
    }
 
    return !SAFE_PREFIXES.some((p) => command.trim().startsWith(p));
  };
}

const tools = {
  read: createReadTool(sandbox),
  grep: createGrepTool(sandbox),
  bash: createBashTool(sandbox, createApproval({ mode: "interactive" })),
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
  tools,
  stopWhen: stepCountIs(10),
});

const prompt = process.argv.slice(3).join(" ") || "Hello!";
const { text, steps } = await agent.generate({ prompt });
console.log(text);
console.log(`\n(${steps.length} steps)`);
