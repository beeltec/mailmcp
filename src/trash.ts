import type { Interface } from 'node:readline/promises';

type Mailbox = { path: string[] };

function normalized(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

const names = new Set([
  'Trash', 'Bin', 'Deleted Messages', 'Deleted Items',
  'Papierkorb', 'Corbeille', 'Cestino', 'Papelera', 'Prullenmand',
  'Lixo', 'Papirkurv', 'ゴミ箱', '휴지통',
].map(normalized));
const namespaces = new Set(['inbox', '[gmail]', '[google mail]']);

function detectTrash(mailboxes: Mailbox[], assignedNames: string[]): string[] | undefined {
  if (assignedNames.length > 0) {
    if (assignedNames.length !== 1) return undefined;
    const matches = mailboxes.filter(mailbox => mailbox.path.at(-1) === assignedNames[0]);
    return matches.length === 1 ? matches[0]!.path : undefined;
  }
  const matches = mailboxes.filter(mailbox => {
    const path = mailbox.path.map(normalized);
    if (path.length === 1) return names.has(path[0]!);
    return path.length === 2 && namespaces.has(path[0]!) && names.has(path[1]!);
  });
  return matches.length === 1 ? matches[0]!.path : undefined;
}

export async function selectTrash(
  accountName: string, mailboxes: Mailbox[], assignedNames: string[], terminal: Interface,
): Promise<string[]> {
  if (!mailboxes.length) throw new Error(`No mailboxes found for ${accountName}. Configuration was not changed.`);
  const detected = detectTrash(mailboxes, assignedNames);
  if (detected) {
    console.log(`\nTrash for ${accountName}: ${detected.join(' / ')} (automatically detected)`);
    return detected;
  }
  console.log(`\nCould not determine a unique Trash mailbox for ${accountName}.`);
  mailboxes.forEach((mailbox, index) => console.log(`${index + 1}. ${mailbox.path.join(' / ')}`));
  const index = Number(await terminal.question('Which mailbox is Trash? Enter its number: ')) - 1;
  const trash = mailboxes[index]?.path;
  if (!Number.isInteger(index) || !trash) throw new Error('Choose a valid Trash mailbox. Configuration was not changed.');
  return trash;
}
