import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { configPath } from './config.js';

export type Harness = {
  label: string;
  hint?: string | undefined;
  install(): Promise<void>;
  uninstall(): Promise<void>;
};
export type HarnessStatus = { harness: Harness; installed: boolean; error?: string };
type Detectable = Harness & { available(): Promise<boolean>; entry(): Promise<unknown> };

const name = 'mail';
const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))];
const env = process.env.MAILMCP_CONFIG ? { MAILMCP_CONFIG: configPath() } : undefined;
const stdio = { command: command[0], args: command.slice(1), ...(env && { env }) };
const run = promisify(execFile);
const jsonObject = z.record(z.string(), z.unknown());

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function commandExists(file: string): Promise<boolean> {
  return run(file, ['--version']).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT');
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function servers(text: string | undefined, key: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const config = jsonObject.safeParse(text?.trim() ? parse(text, errors, { allowTrailingComma: true }) : {});
  if (errors.length || !config.success) throw new Error(`${path} is not a valid JSON object.`);
  const entries = jsonObject.optional().safeParse(config.data[key]);
  if (!entries.success) throw new Error(`${key} in ${path} is not a JSON object.`);
  return entries.data ?? {};
}

async function replaceFile(path: string, text: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then(info => info.mode & 0o777, () => 0o600);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode, flag: 'wx' });
  await rename(temporary, target);
}

function jsonHarness(label: string, directory: string, paths: string[], key: string, value: object, hint?: string): Detectable {
  async function update(path: string, entry: object | undefined): Promise<void> {
    const text = await readText(path) ?? '';
    servers(text, key, path);
    const edits = modify(text, [key, name], entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
    await replaceFile(path, applyEdits(text, edits));
  }
  async function containing(): Promise<Array<{ path: string; entry: unknown }>> {
    const found = await Promise.all(paths.map(async path => ({ path, entry: servers(await readText(path), key, path)[name] })));
    return found.filter(item => item.entry !== undefined);
  }
  return {
    label, hint,
    available: () => exists(directory),
    entry: async () => (await containing())[0]?.entry,
    install: async () => {
      const existing = await Promise.all(paths.map(exists));
      await update(paths[existing.indexOf(true)] ?? paths[0]!, value);
    },
    uninstall: async () => {
      for (const { path } of await containing()) await update(path, undefined);
    },
  };
}

const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
const gemini = join(process.env.GEMINI_CLI_HOME ?? home, '.gemini');

const harnesses: Detectable[] = [
  {
    label: 'Claude Code',
    hint: 'user scope',
    available: () => commandExists('claude'),
    entry: async () => {
      const path = join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');
      return servers(await readText(path), 'mcpServers', path)[name];
    },
    install: async () => { await run('claude', ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify({ type: 'stdio', ...stdio })]); },
    uninstall: async () => { await run('claude', ['mcp', 'remove', '--scope', 'user', name]); },
  },
  {
    label: 'Codex',
    available: () => commandExists('codex'),
    entry: async () => {
      const { stdout } = await run('codex', ['mcp', 'list', '--json']);
      return z.array(z.looseObject({ name: z.string() })).parse(JSON.parse(stdout)).find(server => server.name === name);
    },
    install: async () => {
      const options = env ? ['--env', `MAILMCP_CONFIG=${env.MAILMCP_CONFIG}`] : [];
      await run('codex', ['mcp', 'add', name, ...options, '--', ...command]);
    },
    uninstall: async () => { await run('codex', ['mcp', 'remove', name]); },
  },
  jsonHarness('Cursor', join(home, '.cursor'), [join(home, '.cursor', 'mcp.json')], 'mcpServers', stdio),
  jsonHarness('Gemini CLI', gemini, [join(gemini, 'settings.json')], 'mcpServers', stdio),
  jsonHarness('opencode', join(xdgConfig, 'opencode'),
    [join(xdgConfig, 'opencode', 'opencode.json'), join(xdgConfig, 'opencode', 'opencode.jsonc')], 'mcp',
    { type: 'local', command, enabled: true, ...(env && { environment: env }) }),
  jsonHarness('pi', process.env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent'), [join(home, '.config', 'mcp', 'mcp.json')], 'mcpServers',
    stdio, 'requires pi-mcp-adapter'),
];

export async function harnessStatus(): Promise<HarnessStatus[]> {
  const statuses = await Promise.all(harnesses.map(async harness => {
    if (!await harness.available()) return undefined;
    try {
      const entry = await harness.entry();
      const text = JSON.stringify(entry) ?? '';
      if (entry !== undefined && !text.includes('mailmcp') && !text.includes(JSON.stringify(command[1]).slice(1, -1))) {
        return { harness, installed: false, error: `another MCP server uses the name ${name}` };
      }
      return { harness, installed: entry !== undefined };
    } catch (error) {
      return { harness, installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return statuses.filter(status => status !== undefined);
}
