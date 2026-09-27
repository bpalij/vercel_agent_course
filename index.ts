import { parseArgs } from "node:util";
import { ToolLoopAgent, stepCountIs, pruneMessages } from "ai";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalSandbox } from "./src/sandbox-local";
import { createJustBashSandbox } from "./src/sandbox-just-bash";
import { buildSystemPrompt } from "./src/system";
import { addCacheControl } from "./src/cache";
import { discoverGates } from "./src/verification";
import type { Sandbox } from "./src/sandbox";
import { anthropic } from '@ai-sdk/anthropic';
import { discoverSkills } from "./src/skills";
import { createRegistry, registerBuiltins, wrapTool } from "./src/registry";
import { tool } from "ai";
import { z } from "zod";
 
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

const skillDirs = [
  join(cwd, "skills"),
  join(process.env.HOME ?? "", ".harness", "skills"),
];
const skills = discoverSkills(skillDirs);
 
async function sandboxFromFlag(name: string, dir: string): Promise<Sandbox> {
  if (name === "just-bash") return createJustBashSandbox(dir);
  return createLocalSandbox(dir);
}
 
const sandbox = await sandboxFromFlag(values.sandbox!, cwd);
console.error(`Sandbox: ${sandbox.type}`);

const registry = createRegistry();
registerBuiltins(registry, sandbox, skills);

registry.register("now", tool({
  description: "Return the current timestamp",
  inputSchema: z.object({}),
  execute: async () => new Date().toISOString(),
}));
 
registry.register("deploy", tool({
  description: `Deploy the project to a target environment.
WHEN TO USE: pushing changes to staging or production.
WHEN NOT TO USE: testing changes (use bash with the test runner instead).`,
  inputSchema: z.object({
    environment: z.enum(["staging", "production"]),
  }),
  execute: async ({ environment }) => {
    const { stdout } = await sandbox.exec(`vercel deploy --${environment}`);
    return stdout;
  },
}));

const baseBash = registry.get("bash")!;
registry.register("bash", wrapTool(baseBash, {
  beforeExecute: (input) => {
    if (input.command.startsWith("bun test")) {
      return { ...input, command: input.command + " --reporter=spec" };
    }
    return input;
  },
}));
 
const projectContext = existsSync(join(cwd, "AGENTS.md"))
  ? readFileSync(join(cwd, "AGENTS.md"), "utf-8")
  : undefined;
 
const verificationCommands = await discoverGates(sandbox);
 
const agent = new ToolLoopAgent({
  model: values.model || anthropic("claude-haiku-4-5-20251001"),
  instructions: buildSystemPrompt({
    workingDirectory: cwd,
    sandboxType: sandbox.type,
    toolNames: registry.list(),
    projectContext,
    verificationCommands,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
  }),
  tools: Object.fromEntries(registry.entries()),
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
  const result = await agent.stream({ prompt });

  // fullStream is marked deprecated in AI SDK in favor of UI streams, but required for CLI streaming
  for await (const chunk of result.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        process.stdout.write(chunk.text); // Changed from chunk.textDelta
        break;
      case "tool-call":
        console.error(
          `\n[tool] \(${chunk.toolName}(\)${JSON.stringify(chunk.input)})`, // Changed from chunk.args
        );
        break;
      case "tool-result": {
        const preview =
          typeof chunk.output === "string" // Changed from chunk.result
            ? chunk.output.slice(0, 100)    // Changed from chunk.result
            : JSON.stringify(chunk.output).slice(0, 100); // Changed from chunk.result
        console.error(`  -> ${preview}`);
        break;
      }
    }
  }
  
  console.log();
} finally {
  await sandbox.stop();
}