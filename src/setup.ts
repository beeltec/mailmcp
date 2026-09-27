import { stdin } from 'node:process';
import { confirm, groupMultiselect, intro, isCancel, log, multiselect, outro, select, spinner } from '@clack/prompts';
import { z } from 'zod';
import { callMail } from './bridge.js';
import { configPath, loadConfig, mailboxPath, saveConfig, type AccountConfig } from './config.js';
import { harnessStatus } from './harnesses.js';
import { toolGroups, toolNames } from './tools.js';
import { detectTrash } from './trash.js';

const accountsSchema = z.array(z.object({ id: z.string(), name: z.string(), emails: z.array(z.string()) }));
const setupMailboxesSchema = z.object({
  mailboxes: z.array(z.object({ path: mailboxPath, ambiguous: z.boolean() })),
  trashNames: z.array(z.string()),
});

function answer<T>(value: T): Exclude<T, symbol> {
  if (isCancel(value)) throw new Error('Setup cancelled.');
  return value as Exclude<T, symbol>;
}

async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  // Clack exits with status 0 when the user presses Ctrl+C during a spinner.
  const cancelled = () => {
    process.exitCode = 1;
    console.error('\nSetup cancelled.');
  };
  process.once('exit', cancelled);
  const progress = spinner({ onCancel: () => process.exit(1) });
  progress.start(message);
  try {
    const result = await task();
    progress.stop(message);
    return result;
  } catch (error) {
    progress.error(message);
    throw error;
  } finally {
    process.off('exit', cancelled);
  }
}

export async function setup(): Promise<void> {
  if (!stdin.isTTY) throw new Error('Run setup in an interactive terminal. You can also edit the configuration file directly.');
  intro('mailmcp setup');
  const current = await loadConfig().catch(() => undefined);
  const accounts = accountsSchema.parse(await withSpinner('Reading Mail accounts', () => callMail('discover_accounts')));
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
      await withSpinner(`Reading mailboxes of ${account.name}`, () => callMail('setup_mailboxes', {}, partial)));
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
  const tools = answer(await groupMultiselect({
    message: 'Which tools can the MCP server offer? list_accounts is always on.',
    options: Object.fromEntries(Object.entries(toolGroups).map(([group, names]) => [group, names.map(value => ({ value }))])),
    initialValues: current?.tools ?? toolNames,
    required: false,
  }));
  await saveConfig({ accounts: selected, tools });
  log.success(`Saved ${configPath()}`);
  await manageHarnesses();
  outro('Restart your MCP connections to apply changes.');
}

async function manageHarnesses(): Promise<void> {
  const statuses = await withSpinner('Looking for harnesses', harnessStatus);
  if (!statuses.length) {
    log.warn('No supported harness found. Add the MCP server to your client manually.');
    return;
  }
  const chosen = answer(await multiselect({
    message: 'Install the MCP server in which harnesses? Unselect a harness to uninstall.',
    options: statuses.map(({ harness, installed, current, error }) => ({
      value: harness.label, label: harness.label, disabled: error !== undefined,
      hint: [error ?? (installed ? 'installed' : 'not installed'), installed && !current && (harness.update ? 'outdated' : 'outdated, reinstall to update'), harness.hint].filter(Boolean).join(', '),
    })),
    initialValues: statuses.filter(status => status.installed).map(status => status.harness.label),
    required: false,
  }));
  const install = statuses.filter(status => !status.error && !status.installed && chosen.includes(status.harness.label));
  const refresh = statuses.filter(status =>
    !status.error && status.installed && !status.current && status.harness.update && chosen.includes(status.harness.label));
  const uninstall = statuses.filter(status => !status.error && status.installed && !chosen.includes(status.harness.label));
  if (!install.length && !refresh.length && !uninstall.length) return;
  if (uninstall.length && !answer(await confirm({
    message: `Uninstall the MCP server from ${uninstall.map(status => status.harness.label).join(', ')}?`,
  }))) uninstall.length = 0;
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
  if (failed.length) throw new Error(`Could not change ${failed.join(', ')}. The account configuration was saved.`);
}
