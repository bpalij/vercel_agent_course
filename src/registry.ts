import { tool, type Tool } from "ai";
import type { Sandbox } from "./sandbox";
import { createReadTool, createGrepTool, createBashTool, createTaskTool, createAskUserTool, createTodoTool, createLoadSkillTool } from "./tools";
import { createApproval } from "./approval";
import type { Skill } from "./skills";
 
export interface ToolRegistry {
  register(name: string, tool: Tool): void;
  get(name: string): Tool | undefined;
  list(): string[];
  entries(): [string, Tool][];
}
 
export function createRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();
  return {
    register: (name, tool) => {
      tools.set(name, tool);
    },
    get: (name) => tools.get(name),
    list: () => [...tools.keys()],
    entries: () => [...tools.entries()],
  };
}

export function registerBuiltins(
  registry: ToolRegistry,
  sandbox: Sandbox,
  skills: Skill[],
) {
  registry.register("read", createReadTool(sandbox));
  registry.register("grep", createGrepTool(sandbox));
  registry.register(
    "bash",
    createBashTool(sandbox, createApproval({ mode: "interactive" })),
  );
  registry.register(
    "task",
    createTaskTool(sandbox, {
      read: registry.get("read")!,
      grep: registry.get("grep")!,
    }),
  );
  registry.register("askUser", createAskUserTool());
  registry.register("todo", createTodoTool());
  registry.register("loadSkill", createLoadSkillTool(skills));
}

interface WrapHooks {
  beforeExecute?: (input: any) => any | Promise<any>;
  afterExecute?: (result: any) => any | Promise<any>;
}
 
// fixing base.execute ts error
export function wrapTool(base: Tool, hooks: WrapHooks): Tool {
  return tool({
    description: base.description,
    inputSchema: base.inputSchema,
    execute: async (input, options) => {
      const transformed = hooks.beforeExecute 
        ? await hooks.beforeExecute(input) 
        : input;

      if (!base.execute) {
        throw new Error("Base tool does not have an execute function");
      }

      const result = await base.execute(transformed, options);

      return hooks.afterExecute 
        ? await hooks.afterExecute(result) 
        : result;
    },
  });
}
