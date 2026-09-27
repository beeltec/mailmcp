import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

export type Harness = {
  label: string;
  hint?: string | undefined;
  install(): Promise<void>;
  uninstall(): Promise<void>;
};
export type HarnessStatus = { harness: Harness; installed: boolean; error?: string };
type Detectable = Harness & { available(): Promise<boolean>; installed(): Promise<boolean> };

const name = 'mail';
const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))];
const run = promisify(execFile);
const jsonObject = z.record(z.string(), z.unknown());

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function commandExists(file: string): Promise<boolean> {
  return run(file, ['--version']).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed;
  try {
    parsed = jsonObject.safeParse(JSON.parse(text));
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!parsed.success) throw new Error(`${path} does not contain a JSON object.`);
  return parsed.data;
}

function servers(config: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const parsed = jsonObject.optional().safeParse(config[key]);
  if (!parsed.success) throw new Error(`${key} in ${path} is not a JSON object.`);
  return parsed.data ?? {};
}

function jsonHarness(label: string, directory: string, path: string, key: string, entry: object, hint?: string): Detectable {
  async function update(change: (entries: Record<string, unknown>) => void): Promise<void> {
    const config = await readJson(path);
    const entries = servers(config, key, path);
    change(entries);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...config, [key]: entries }, null, 2)}\n`);
  }
  return {
    label, hint,
    available: () => exists(directory),
    installed: async () => name in servers(await readJson(path), key, path),
    install: () => update(entries => { entries[name] = entry; }),
    uninstall: () => update(entries => { delete entries[name]; }),
  };
}

const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
const stdio = { command: command[0], args: command.slice(1) };

const harnesses: Detectable[] = [
  {
    label: 'Claude Code',
    hint: 'user scope',
    available: () => commandExists('claude'),
    installed: async () => {
      const path = join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
      return name in servers(await readJson(path), 'mcpServers', path);
    },
    install: async () => { await run('claude', ['mcp', 'add', '--scope', 'user', name, '--', ...command]); },
    uninstall: async () => { await run('claude', ['mcp', 'remove', '--scope', 'user', name]); },
  },
  {
    label: 'Codex',
    available: () => commandExists('codex'),
    installed: async () => {
      const { stdout } = await run('codex', ['mcp', 'list', '--json']);
      return z.array(z.object({ name: z.string() })).parse(JSON.parse(stdout)).some(server => server.name === name);
    },
    install: async () => { await run('codex', ['mcp', 'add', name, '--', ...command]); },
    uninstall: async () => { await run('codex', ['mcp', 'remove', name]); },
  },
  jsonHarness('Cursor', join(home, '.cursor'), join(home, '.cursor', 'mcp.json'), 'mcpServers', stdio),
  jsonHarness('Gemini CLI', join(home, '.gemini'), join(home, '.gemini', 'settings.json'), 'mcpServers', stdio),
  jsonHarness('opencode', join(xdgConfig, 'opencode'), join(xdgConfig, 'opencode', 'opencode.json'), 'mcp',
    { type: 'local', command, enabled: true }),
  jsonHarness('pi', process.env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent'), join(xdgConfig, 'mcp', 'mcp.json'), 'mcpServers',
    stdio, 'requires pi-mcp-adapter'),
];

export async function harnessStatus(): Promise<HarnessStatus[]> {
  const statuses = await Promise.all(harnesses.map(async harness => {
    if (!await harness.available()) return undefined;
    try {
      return { harness, installed: await harness.installed() };
    } catch (error) {
      return { harness, installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return statuses.filter(status => status !== undefined);
}
