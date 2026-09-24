import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A real, valid `Renderer` plugin module, written to `dir` for a spawned server.ts to import. */
export async function writeValidRendererPlugin(dir: string): Promise<string> {
  const path = join(dir, 'renderer.mjs');
  await writeFile(
    path,
    "export default { async render() { return [{ path: 'ghost.env', content: 'NODE_ENV=production\\n' }]; } };\n"
  );
  return path;
}

export async function writeValidAdminApiPlugin(dir: string): Promise<string> {
  const path = join(dir, 'adminApi.mjs');
  await writeFile(path, 'export default { async configure() {} };\n');
  return path;
}

export async function writeValidDrainSourcePlugin(dir: string): Promise<string> {
  const path = join(dir, 'drainSource.mjs');
  await writeFile(path, 'export default { async poll() { return new Promise(() => {}); } };\n');
  return path;
}

/** Loads cleanly but its default export has none of the required seam functions. */
export async function writeShapelessPlugin(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, 'export default {};\n');
  return path;
}
