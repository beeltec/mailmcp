import { homedir } from 'node:os';
import { relative } from 'node:path';
import { cwd, stdin } from 'node:process';
import { confirm, groupMultiselect, intro, isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import { z } from 'zod';
import { callMail } from './bridge.js';
import { configPath, loadConfig, mailboxPath, saveConfig, type AccountConfig, type Config } from './config.js';
import { harnessStatus, type Harness, type HarnessStatus, type Scope } from './harnesses.js';
import { destructiveTools, toolGroups, toolNames, type ToolName } from './tools.js';
import { detectTrash } from './trash.js';

const accountsSchema = z.array(z.object({ id: z.string(), name: z.string(), emails: z.array(z.string()) }));
const setupMailboxesSchema = z.object({
  mailboxes: z.array(z.object({ path: mailboxPath, ambiguous: z.boolean() })),
  trashNames: z.array(z.string()),
});

class Cancelled extends Error {}

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new Cancelled('Setup cancelled.');
  return value as Exclude<T, symbol>;
}

async function withProgress<T>(message: string, task: () => Promise<T>): Promise<T> {
  log.step(message);
  let cancel = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Cancelled('Setup cancelled.'));
  });
  process.once('SIGINT', cancel);
  try {
    return await Promise.race([task(), cancelled]);
  } finally {
    process.off('SIGINT', cancel);
  }
}

export async function setup(): Promise<void> {
  if (!stdin.isTTY) throw new Error('Run setup in an interactive terminal. You can also edit the configuration file directly.');
  intro('mailmcp setup');
  const current = await loadConfig().catch(() => undefined);
  if (current) await menu(current);
  else {
    const accounts = await selectAccounts(undefined);
    const tools = await selectTools(toolNames.filter(name => !destructiveTools.includes(name)));
    await save({ accounts, tools });
    await manageHarnesses();
  }
  outro('Restart your MCP connections to apply changes.');
}

async function menu(config: Config): Promise<void> {
  let choice = 'accounts';
  for (;;) {
    choice = answer(await select({
      message: 'What do you want to change?',
      initialValue: choice,
      options: [
        { value: 'accounts', label: 'Accounts and Trash mailboxes', hint: `${config.accounts.length} selected` },
        { value: 'tools', label: 'Tools', hint: `${(config.tools ?? toolNames).length} of ${toolNames.length} enabled` },
        { value: 'harnesses', label: 'Harnesses', hint: 'user or project scope' },
        { value: 'exit', label: 'Exit' },
      ],
    }));
    if (choice === 'exit') return;
    try {
      if (choice === 'accounts') config = await save({ ...config, accounts: await selectAccounts(config) });
      else if (choice === 'tools') config = await save({ ...config, tools: await selectTools(config.tools ?? toolNames) });
      else await manageHarnesses();
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      log.info('Cancelled. Nothing was changed.');
    }
  }
}

async function save(config: Config): Promise<Config> {
  await saveConfig(config);
  log.success(`Saved ${configPath()}`);
  return config;
}

async function selectAccounts(current: Config | undefined): Promise<AccountConfig[]> {
  const accounts = accountsSchema.parse(await withProgress('Reading Mail accounts', () => callMail('discover_accounts')));
  if (!accounts.length) throw new Error('No Mail accounts found. Configure Apple Mail first.');
  const ids = answer(await multiselect({
    message: 'Which accounts can the MCP server use? Press A to select all.',
    options: accounts.map(account => {
      const emails = account.emails.join(', ');
      return { value: account.id, label: emails === account.name ? account.name : `${account.name} (${emails})` };
    }),
    initialValues: current?.accounts.map(account => account.id).filter(id => accounts.some(account => account.id === id)) ?? [],
  }));
  const selected: AccountConfig[] = [];
  for (const account of accounts.filter(item => ids.includes(item.id))) {
    const email = account.emails.length > 1 ? answer(await select({
      message: `Sender email for ${account.name}`,
      options: account.emails.map(value => ({ value })),
      initialValue: current?.accounts.find(item => item.id === account.id)?.email ?? account.emails[0],
    })) : account.emails[0];
    if (!email) throw new Error(`${account.name} has no email address. Configuration was not changed.`);
    const partial = { id: account.id, email, trash: ['pending'] };
    const { mailboxes, trashNames } = setupMailboxesSchema.parse(
      await withProgress(`Reading mailboxes of ${account.name}`, () => callMail('setup_mailboxes', {}, partial)));
    const usable = mailboxes.filter(mailbox => !mailbox.ambiguous);
    if (!usable.length) throw new Error(`No mailboxes found for ${account.name}. Configuration was not changed.`);
    let trash = detectTrash(usable, trashNames);
    if (trash) log.info(`Trash for ${account.name}: ${trash.join(' / ')} (automatically detected)`);
    else {
      const saved = JSON.stringify(current?.accounts.find(item => item.id === account.id)?.trash);
      trash = answer(await select({
        message: `Which mailbox is Trash for ${account.name}?`,
        options: usable.map(mailbox => ({ value: mailbox.path, label: mailbox.path.join(' / ') })),
        initialValue: usable.find(mailbox => JSON.stringify(mailbox.path) === saved)?.path ?? usable[0]!.path,
        maxItems: 15,
      }));
    }
    selected.push({ id: account.id, email, trash });
  }
  return selected;
}

async function selectTools(initialValues: ToolName[]): Promise<ToolName[]> {
  return answer(await groupMultiselect({
    message: 'Which tools can the MCP server offer? list_accounts is always on.',
    options: Object.fromEntries(Object.entries(toolGroups).map(([group, names]) =>
      [group, names.map(value => ({ value, ...(destructiveTools.includes(value) && { hint: 'destructive' }) }))])),
    initialValues,
    required: false,
  }));
}

function displayPath(path: string, scope: Scope): string {
  if (scope === 'project') return relative(cwd(), path);
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function displayLocations(harness: Harness, scope: Scope): string {
  return harness.locations.map(path => displayPath(path, scope)).join(', ');
}

async function manageHarnesses(): Promise<void> {
  const root = cwd();
  const inHome = root === homedir();
  const scope = answer(await select<Scope>({
    message: 'Where do you want to install the MCP server?',
    options: [
      { value: 'user', label: 'User', hint: 'all your projects' },
      { value: 'project', label: 'Project', hint: inHome ? 'not available in your home directory' : displayPath(root, 'user'), disabled: inHome },
    ],
  }));
  const statuses = await withProgress('Looking for harnesses', () => harnessStatus(scope, root));
  if (!statuses.length) {
    log.warn('No supported harness found. Add the MCP server to your client manually.');
    return;
  }
  const chosen = answer(await multiselect({
    message: `Install the MCP server in which harnesses (${scope} scope)? Unselect a harness to uninstall.`,
    options: statuses.map(({ harness, installed, current, error }) => ({
      value: harness.label, label: harness.label, disabled: error !== undefined,
      hint: [
        error ?? (installed ? 'installed' : 'not installed'),
        installed && !current && (harness.update ? 'outdated' : 'outdated, reinstall to update'),
        displayLocations(harness, scope), harness.hint,
      ].filter(Boolean).join(', '),
    })),
    initialValues: statuses.filter(status => status.installed).map(status => status.harness.label),
    required: false,
  }));
  const selected = statuses.filter(status => !status.error && chosen.includes(status.harness.label));
  const install = selected.filter(status => !status.installed);
  const refresh = selected.filter(status => status.installed && !status.current && status.harness.update);
  const unselected = statuses.filter(status => !status.error && !chosen.includes(status.harness.label));
  const sharing = ({ harness }: HarnessStatus) =>
    selected.find(other => other.harness.locations.some(path => harness.locations.includes(path)))?.harness.label;
  const shared = unselected.filter(sharing);
  const uninstall = unselected.filter(status => status.installed && !shared.includes(status));
  if (!install.length && !refresh.length && !uninstall.length) {
    for (const status of shared) log.info(`${status.harness.label} stays installed because ${sharing(status)} uses the same file.`);
    log.info('Nothing to change.');
    return;
  }
  const rows = [
    ...install.map(status => ['Install', status.harness.label, displayLocations(status.harness, scope)]),
    ...refresh.map(status => ['Update', status.harness.label, displayLocations(status.harness, scope)]),
    ...uninstall.map(status => ['Uninstall', status.harness.label, displayLocations(status.harness, scope)]),
    ...shared.map(status => [status.installed ? 'Keep' : 'Install', status.harness.label, `${sharing(status)} uses the same file`]),
  ];
  const widths = [0, 1].map(column => Math.max(...rows.map(row => row[column]!.length)));
  note(rows.map(([action, label, detail]) => `${action!.padEnd(widths[0]!)}  ${label!.padEnd(widths[1]!)}  ${detail}`).join('\n'),
    `Changes (${scope} scope)`);
  if (scope === 'project' && install.length + refresh.length) {
    log.warn('Project files will contain paths on this computer. Other people cannot use them as they are.');
  }
  if (!answer(await confirm({ message: 'Apply these changes?' }))) {
    log.info('Nothing was changed.');
    return;
  }
  const failed: string[] = [];
  const wait = () => log.warn('Wait until the harness changes are complete.');
  process.on('SIGINT', wait);
  try {
    for (const [action, list] of [['Installed in', install], ['Updated in', refresh], ['Uninstalled from', uninstall]] as const) {
      for (const { harness } of list) {
        try {
          await (action === 'Installed in' ? harness.install() : action === 'Updated in' ? harness.update?.() : harness.uninstall());
          log.success(`${action} ${harness.label}`);
        } catch (error) {
          failed.push(harness.label);
          log.error(`${harness.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    process.off('SIGINT', wait);
  }
  if (failed.length) {
    log.error(`Could not change ${failed.join(', ')}.`);
    process.exitCode = 1;
  }
}
