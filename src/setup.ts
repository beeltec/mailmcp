import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { z } from 'zod';
import { callMail } from './bridge.js';
import { configPath, mailboxPath, saveConfig, type AccountConfig } from './config.js';
import { selectTrash } from './trash.js';

const accountsSchema = z.array(z.object({ id: z.string(), name: z.string(), emails: z.array(z.string()) }));
const setupMailboxesSchema = z.object({
  mailboxes: z.array(z.object({ path: mailboxPath })),
  trashNames: z.array(z.string()),
});

export async function setup(): Promise<void> {
  if (!stdin.isTTY) throw new Error('Run setup in an interactive terminal. You can also edit the configuration file directly.');
  const accounts = accountsSchema.parse(await callMail('discover_accounts'));
  if (!accounts.length) throw new Error('No Mail accounts found. Configure Apple Mail first.');
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    accounts.forEach((account, index) => console.log(`${index + 1}. ${account.name} (${account.emails.join(', ')})`));
    const selection = await terminal.question('Allow accounts (All or numbers separated by commas; replaces the current list): ');
    const numbers = selection.trim().toLowerCase() === 'all'
      ? accounts.map((_account, index) => index + 1)
      : selection.split(',').map(value => Number(value.trim()));
    if (!numbers.length || numbers.some(value => !Number.isInteger(value) || value < 1 || value > accounts.length)) {
      throw new Error('Enter All or valid account numbers. Configuration was not changed.');
    }
    const selected: AccountConfig[] = [];
    for (const number of new Set(numbers)) {
      const account = accounts[number - 1]!;
      let email = account.emails[0];
      if (account.emails.length > 1) email = await terminal.question(`Sender email for ${account.name} (${account.emails.join(', ')}): `);
      if (!email || !account.emails.includes(email)) throw new Error('Select an email configured in this account.');
      const partial = { id: account.id, email, trash: ['pending'] };
      const { mailboxes, trashNames } = setupMailboxesSchema.parse(await callMail('setup_mailboxes', {}, partial));
      const trash = await selectTrash(account.name, mailboxes, trashNames, terminal);
      selected.push({ id: account.id, email, trash });
    }
    await saveConfig({ accounts: selected });
    console.log(`\nSaved ${configPath()}. Restart your MCP connection to apply changes.`);
  } finally { terminal.close(); }
}
