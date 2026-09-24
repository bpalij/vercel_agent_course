import type { Sandbox } from "./sandbox";
 
export async function discoverGates(sandbox: Sandbox): Promise<string[]> {
  try {
    const raw = await sandbox.readFile("package.json");
    const pkg = JSON.parse(raw);
    const scripts = pkg.scripts ?? {};
    const gates: string[] = [];
 
    if (scripts.typecheck || scripts["type-check"]) {
      gates.push("npm run typecheck");
    } else if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
      gates.push("npx tsc --noEmit");
    }
 
    if (scripts.lint) gates.push("npm run lint");
    if (scripts.test) gates.push("npm test");
    if (scripts.build) gates.push("npm run build");
 
    return gates;
  } catch {
    return [];
  }
}