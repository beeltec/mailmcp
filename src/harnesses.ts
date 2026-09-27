import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
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
export type HarnessStatus = { harness: Harness; installed: boolean; current: boolean; error?: string };
type Detectable = Harness & { available(): Promise<boolean>; entries(): Promise<unknown[]> };

const name = 'mail';
const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))];
const env = process.env.MAILMCP_CONFIG ? { MAILMCP_CONFIG: configPath() } : undefined;
const stdio = { command: command[0], args: command.slice(1), ...(env && { env }) };
const run = promisify(execFile);
const jsonObject = z.record(z.string(), z.unknown());
const strings = z.record(z.string(), z.string()).nullish();
const launchSchema = z.looseObject({
  command: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.array(z.string()).nullish(),
  env: strings,
  environment: strings,
});

function launch(entry: unknown): { argv: string[]; env: Record<string, string> } {
  const codex = z.looseObject({ transport: z.unknown() }).safeParse(entry);
  const parsed = launchSchema.safeParse(codex.success ? codex.data.transport : entry);
  if (!parsed.success) return { argv: [], env: {} };
  const { command: executable = [], args, env: variables, environment } = parsed.data;
  return { argv: [executable, args ?? []].flat(), env: variables ?? environment ?? {} };
}

function owned(entry: unknown): boolean {
  return launch(entry).argv.some(value => value === command[1] || value.includes('mailmcp'));
}

function current(entry: unknown): boolean {
  const { argv, env: variables } = launch(entry);
  return JSON.stringify(argv) === JSON.stringify(command) && variables.MAILMCP_CONFIG === env?.MAILMCP_CONFIG;
}

async function check(harness: Detectable): Promise<{ installed: boolean; current: boolean }> {
  const entries = await harness.entries();
  if (!entries.every(owned)) throw new Error(`another MCP server uses the name ${name}`);
  return { installed: entries.length > 0, current: entries.every(current) };
}

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
  const link = await lstat(path).then(info => info.isSymbolicLink(), () => false);
  const target = link ? await realpath(path).catch(() => { throw new Error(`${path} is a broken symbolic link.`); }) : path;
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
    entries: async () => (await containing()).map(item => item.entry),
    install: async () => {
      const found = (await containing()).map(item => item.path);
      const existing = await Promise.all(paths.map(exists));
      for (const path of found.length ? found : [paths[existing.indexOf(true)] ?? paths[0]!]) await update(path, value);
    },
    uninstall: async () => {
      for (const { path } of await containing()) await update(path, undefined);
    },
  };
}

const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
const gemini = join(process.env.GEMINI_CLI_HOME ?? home, '.gemini');
const claude = join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');

const harnesses: Detectable[] = [
  {
    label: 'Claude Code',
    hint: 'user scope',
    available: () => commandExists('claude'),
    entries: async () => {
      const entry = servers(await readText(claude), 'mcpServers', claude)[name];
      return entry === undefined ? [] : [entry];
    },
    install: async () => {
      if (name in servers(await readText(claude), 'mcpServers', claude)) await run('claude', ['mcp', 'remove', '--scope', 'user', name]);
      await run('claude', ['mcp', 'add-json', '--scope', 'user', name, JSON.stringify({ type: 'stdio', ...stdio })]);
    },
    uninstall: async () => { await run('claude', ['mcp', 'remove', '--scope', 'user', name]); },
  },
  {
    label: 'Codex',
    available: () => commandExists('codex'),
    entries: async () => {
      const { stdout } = await run('codex', ['mcp', 'list', '--json']);
      return z.array(z.looseObject({ name: z.string() })).parse(JSON.parse(stdout)).filter(server => server.name === name);
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
  const statuses = await Promise.all(harnesses.map(async detectable => {
    if (!await detectable.available()) return undefined;
    const harness: Harness = {
      label: detectable.label, hint: detectable.hint,
      install: async () => { await check(detectable); await detectable.install(); },
      uninstall: async () => { await check(detectable); await detectable.uninstall(); },
    };
    try {
      return { harness, ...await check(detectable) };
    } catch (error) {
      return { harness, installed: false, current: false, error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return statuses.filter(status => status !== undefined);
}
