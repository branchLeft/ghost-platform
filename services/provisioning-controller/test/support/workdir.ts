import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APPROVAL, ENTRY } from './doubles.js';

export const FAKE_HOST = fileURLToPath(new URL('./fakeHost.mjs', import.meta.url));

/** One temp directory holding a deployment's files, as the owner's tooling would lay them out. */
export class Workdir {
  private constructor(readonly dir: string) {}

  static async create(): Promise<Workdir> {
    return new Workdir(await mkdtemp(join(tmpdir(), 'pc-run-')));
  }

  path(name: string): string {
    return join(this.dir, name);
  }

  /** Writes a JSON file the way a trusted writer leaves it: private to this user. */
  async json(name: string, value: unknown, mode = 0o600): Promise<string> {
    const file = this.path(name);
    await writeFile(file, JSON.stringify(value));
    await chmod(file, mode);
    return file;
  }

  async modes(modes: Record<string, string>): Promise<void> {
    await this.json('modes.json', modes);
  }

  /** The steps the fake host was asked to carry out, in order, by step id. */
  async calledIds(): Promise<string[]> {
    try {
      const text = await readFile(this.path('calls.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => (JSON.parse(l) as { id: string }).id);
    } catch {
      return [];
    }
  }

  /** A configuration that serves every entry point with the fake host, plus the approval and register files. */
  async deployment(overrides: Record<string, unknown> = {}): Promise<string> {
    await this.json('approvals.json', { approvals: [APPROVAL] });
    await this.json('register.json', { entries: [ENTRY] });
    const spec = { argv: [process.execPath, FAKE_HOST, this.dir], timeoutMs: 10_000 };
    return this.json('config.json', {
      stateFile: this.path('state.jsonl'),
      approvalsFile: this.path('approvals.json'),
      registerFile: this.path('register.json'),
      hosts: Object.fromEntries(
        ['controller', 'db-host', 'app-host', 'storage-gateway', 'source-host', 'edge', 'dns'].map(
          (name) => [name, spec]
        )
      ),
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
      ...overrides,
    });
  }

  async remove(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
