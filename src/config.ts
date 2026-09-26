import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const mailboxPath = z.array(z.string().min(1).max(512)).min(1).max(30);
export const accountConfig = z.strictObject({
  id: z.string().min(1),
  email: z.email(),
  trash: mailboxPath,
});
export const configSchema = z.strictObject({
  accounts: z.array(accountConfig).min(1).refine(
    accounts => new Set(accounts.map(account => account.id)).size === accounts.length,
    'Account identifiers must be unique.',
  ),
});
export type Config = z.infer<typeof configSchema>;
export type AccountConfig = z.infer<typeof accountConfig>;

export function configPath(): string {
  return resolve(process.env.MAILMCP_CONFIG ?? join(homedir(), '.config', 'mailmcp', 'config.json'));
}

export async function loadConfig(): Promise<Config> {
  try {
    return configSchema.parse(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch (error) {
    throw new Error(`Cannot load ${configPath()}. Run mailmcp setup. ${error instanceof Error ? error.message : ''}`);
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(configSchema.parse(config), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
