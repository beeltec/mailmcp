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

export function detectTrash(mailboxes: Mailbox[], assignedNames: string[]): string[] | undefined {
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
