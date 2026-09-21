import { Sandbox as JustBashSandbox } from "just-bash";
import type { Sandbox } from "./sandbox";
 
const MOUNT = "/home/user/project";
 
export async function createJustBashSandbox(dir: string): Promise<Sandbox> {
  const jb = await JustBashSandbox.create({ overlayRoot: dir });
 
  return {
    type: "just-bash",
    workingDirectory: dir,
    readFile: async (p) => {
      const virtualPath = `${MOUNT}/${p}`;
      return jb.readFile(virtualPath);
    },
    exec: async (command) => {
      const cmd = await jb.runCommand(command, { cwd: MOUNT });
      const finished = await cmd.wait();
      return {
        stdout: await cmd.output(),
        exitCode: finished.exitCode,
      };
    },
    stop: async () => {},
  };
}