import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { parse as parseToml, patch as patchToml } from '@decimalturn/toml-patch';
import { z } from 'zod';
import { configPath } from './config.js';

export type Scope = 'user' | 'project';
export type Harness = {
  label: string;
  hint?: string | undefined;
  locations: string[];
  install(): Promise<void>;
  update?: (() => Promise<void>) | undefined;
  uninstall(): Promise<void>;
};
export type HarnessStatus = { harness: Harness; installed: boolean; current: boolean; error?: string };
type Detectable = Omit<Harness, 'locations'> & {
  available(): Promise<boolean>; locations(): Promise<string[]>; entries(): Promise<unknown[]>; config?: string;
};

const name = 'mail';
const command = [process.execPath, fileURLToPath(new URL('./cli.js', import.meta.url))];
const env = process.env.MAILMCP_CONFIG ? { MAILMCP_CONFIG: configPath() } : undefined;
type Edit = [path: string[], value: unknown];
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
  return launch(entry).argv.slice(0, 2).some(value =>
    value === command[1] || value.endsWith('/mailmcp/dist/cli.js') || basename(value) === 'mailmcp');
}

function stdioEdits(entry: unknown): Edit[] {
  const edits: Edit[] = [[['command'], command[0]], [['args'], command.slice(1)]];
  if (env || launch(entry).env.MAILMCP_CONFIG !== undefined) edits.push([['env', 'MAILMCP_CONFIG'], env?.MAILMCP_CONFIG]);
  return edits;
}

function opencodeEdits(entry: unknown): Edit[] {
  const edits: Edit[] = [[['type'], 'local'], [['command'], command]];
  if (env || launch(entry).env.MAILMCP_CONFIG !== undefined) edits.push([['environment', 'MAILMCP_CONFIG'], env?.MAILMCP_CONFIG]);
  return edits;
}

function edit(text: string, base: string[], edits: Edit[]): string {
  return edits.reduce((result, [path, value]) =>
    applyEdits(result, modify(result, [...base, ...path], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })), text);
}

function current(entry: unknown, config = env?.MAILMCP_CONFIG): boolean {
  const { argv, env: variables } = launch(entry);
  return JSON.stringify(argv) === JSON.stringify(command) && variables.MAILMCP_CONFIG === config;
}

async function check(harness: Detectable): Promise<{ installed: boolean; current: boolean }> {
  const entries = await harness.entries();
  if (!entries.every(owned)) throw new Error(`another MCP server uses the name ${name}`);
  return { installed: entries.length > 0, current: entries.every(entry => current(entry, harness.config)) };
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

function jsonHarness(
  label: string, available: () => Promise<boolean>, paths: string[], key: string, edits: (entry: unknown) => Edit[], hint?: string,
): Detectable {
  async function update(path: string, remove: boolean): Promise<void> {
    const text = await readText(path) ?? '';
    const updated = edit(text, [key, name], remove ? [[[], undefined]] : edits(servers(text, key, path)[name]));
    const entry = servers(updated, key, path)[name];
    if (remove ? entry !== undefined : !current(entry)) throw new Error(`Cannot update ${path}. Check it for duplicate keys.`);
    await replaceFile(path, updated);
  }
  async function containing(): Promise<Array<{ path: string; entry: unknown }>> {
    const found = await Promise.all(paths.map(async path => ({ path, entry: servers(await readText(path), key, path)[name] })));
    return found.filter(item => item.entry !== undefined);
  }
  async function targets(): Promise<string[]> {
    const found = (await containing()).map(item => item.path);
    const existing = await Promise.all(paths.map(exists));
    return found.length ? found : [paths[existing.indexOf(true)] ?? paths[0]!];
  }
  async function install(): Promise<void> {
    for (const path of await targets()) await update(path, false);
  }
  return {
    label, hint, install, update: install, available,
    locations: () => targets().catch(() => [paths[0]!]),
    entries: async () => (await containing()).map(item => item.entry),
    uninstall: async () => {
      for (const { path } of await containing()) await update(path, true);
    },
  };
}

async function installClaude(): Promise<void> {
  const entry = servers(await readText(claude), 'mcpServers', claude)[name];
  const json = edit(JSON.stringify(entry ?? { type: 'stdio' }), [], stdioEdits(entry));
  const add = (value: string) => run('claude', ['mcp', 'add-json', '--scope', 'user', name, value]);
  if (entry !== undefined) await run('claude', ['mcp', 'remove', '--scope', 'user', name]);
  try {
    await add(json);
  } catch (error) {
    if (entry !== undefined) await add(JSON.stringify(entry));
    throw error;
  }
}

async function codex(args: string[]): Promise<string> {
  return (await run('codex', ['mcp', ...args], { cwd: tmpdir() })).stdout;
}

function codexServers(config: Record<string, unknown>, path: string): Record<string, unknown> {
  const entries = jsonObject.optional().safeParse(config.mcp_servers);
  if (!entries.success) throw new Error(`mcp_servers in ${path} is not a table.`);
  return entries.data ?? {};
}

// Codex has no project scope option, so edit the project file directly.
// Codex merges the project entry with the user entry, so always set the configuration path.
function codexProject(path: string): Detectable {
  const configFile = configPath();
  async function read(): Promise<{ text: string; config: Record<string, unknown> }> {
    const text = await readText(path) ?? '';
    try {
      return { text, config: jsonObject.parse(parseToml(text)) };
    } catch {
      throw new Error(`${path} is not valid TOML.`);
    }
  }
  function others(config: Record<string, unknown>): Record<string, unknown> {
    const { [name]: _entry, ...rest } = codexServers(config, path);
    const { mcp_servers: _servers, ...settings } = config;
    return Object.keys(rest).length ? { ...settings, mcp_servers: rest } : settings;
  }
  async function update(remove: boolean): Promise<void> {
    const { text, config } = await read();
    const rest = others(config);
    let updated = rest;
    if (!remove) {
      const { env: variables, ...entry } = jsonObject.parse(codexServers(config, path)[name] ?? {});
      const { MAILMCP_CONFIG: _config, ...kept } = strings.parse(variables) ?? {};
      const environment = { ...kept, MAILMCP_CONFIG: configFile };
      const server = { ...entry, command: command[0], args: command.slice(1), ...(Object.keys(environment).length && { env: environment }) };
      updated = { ...rest, mcp_servers: { ...codexServers(rest, path), [name]: server } };
    }
    let patched: string;
    try {
      patched = patchToml(text, updated);
      const result = jsonObject.parse(parseToml(patched));
      const entry = codexServers(result, path)[name];
      if (!isDeepStrictEqual(others(result), rest) || (remove ? entry !== undefined : !current(entry, configFile))) throw new Error();
    } catch {
      throw new Error(`Cannot update ${path}. Change it manually.`);
    }
    await replaceFile(path, patched.trim() ? `${patched.trimEnd()}\n` : '');
  }
  return {
    label: 'Codex',
    hint: 'trusted projects only',
    config: configFile,
    available: () => commandExists('codex'),
    locations: async () => [path],
    entries: async () => {
      const entry = codexServers((await read()).config, path)[name];
      return entry === undefined ? [] : [entry];
    },
    install: () => update(false),
    update: () => update(false),
    uninstall: () => update(true),
  };
}

const home = homedir();
const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, '.config');
const gemini = join(process.env.GEMINI_CLI_HOME ?? home, '.gemini');
const claude = join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json');

const cursor = join(home, '.cursor');
const opencode = join(xdgConfig, 'opencode');
const pi = process.env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent');

function detectables(scope: Scope, root: string): Detectable[] {
  const hasClaude = () => commandExists('claude');
  const hasGemini = () => exists(gemini);
  const hasOpencode = () => exists(opencode);
  const hasPi = () => exists(pi);
  const piHint = 'requires pi-mcp-adapter';
  if (scope === 'project') return [
    jsonHarness('Claude Code', hasClaude, [join(root, '.mcp.json')], 'mcpServers', stdioEdits, 'asks for approval on first start'),
    codexProject(join(root, '.codex', 'config.toml')),
    jsonHarness('Cursor', () => exists(cursor), [join(root, '.cursor', 'mcp.json')], 'mcpServers', stdioEdits),
    jsonHarness('Gemini CLI', hasGemini, [join(root, '.gemini', 'settings.json')], 'mcpServers', stdioEdits),
    jsonHarness('opencode', hasOpencode, ['opencode.json', 'opencode.jsonc'].map(file => join(root, file)), 'mcp', opencodeEdits),
    jsonHarness('pi', hasPi, [join(root, '.mcp.json')], 'mcpServers', stdioEdits, piHint),
  ];
  return [
    {
      label: 'Claude Code',
      available: hasClaude,
      locations: async () => [claude],
      entries: async () => {
        const entry = servers(await readText(claude), 'mcpServers', claude)[name];
        return entry === undefined ? [] : [entry];
      },
      install: installClaude,
      update: installClaude,
      uninstall: async () => { await run('claude', ['mcp', 'remove', '--scope', 'user', name]); },
    },
    {
      label: 'Codex',
      available: () => commandExists('codex'),
      locations: async () => [join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml')],
      entries: async () => {
        const list = z.array(z.looseObject({ name: z.string() })).parse(JSON.parse(await codex(['list', '--json'])));
        return list.filter(server => server.name === name);
      },
      install: async () => { await codex(['add', name, ...(env ? ['--env', `MAILMCP_CONFIG=${env.MAILMCP_CONFIG}`] : []), '--', ...command]); },
      uninstall: async () => { await codex(['remove', name]); },
    },
    jsonHarness('Cursor', () => exists(cursor), [join(cursor, 'mcp.json')], 'mcpServers', stdioEdits),
    jsonHarness('Gemini CLI', hasGemini, [join(gemini, 'settings.json')], 'mcpServers', stdioEdits),
    jsonHarness('opencode', hasOpencode,
      ['opencode.json', 'opencode.jsonc', 'config.json'].map(file => join(opencode, file)), 'mcp', opencodeEdits),
    jsonHarness('pi', hasPi, [join(home, '.config', 'mcp', 'mcp.json')], 'mcpServers', stdioEdits, piHint),
  ];
}

export async function harnessStatus(scope: Scope, root: string): Promise<HarnessStatus[]> {
  const statuses = await Promise.all(detectables(scope, root).map(async detectable => {
    if (!await detectable.available()) return undefined;
    const { update } = detectable;
    const harness: Harness = {
      label: detectable.label, hint: detectable.hint, locations: await detectable.locations(),
      install: async () => { await check(detectable); await detectable.install(); },
      update: update && (async () => { await check(detectable); await update(); }),
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
