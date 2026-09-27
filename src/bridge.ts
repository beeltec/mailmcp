import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AccountConfig } from './config.js';

const envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const script = fileURLToPath(new URL('../scripts/mail.js', import.meta.url));

export async function callMail(
  operation: string,
  args: object = {},
  account?: AccountConfig,
  signal?: AbortSignal,
): Promise<unknown> {
  if (process.platform !== 'darwin') throw new Error('mailmcp requires macOS and Apple Mail.');
  signal?.throwIfAborted();
  const readOnly = ['discover_accounts', 'account_info', 'list_mailboxes', 'get_mailbox', 'setup_mailboxes', 'search_messages', 'search_mailboxes', 'read_message', 'read_messages', 'get_draft'].includes(operation);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = '';
    let failed = false;
    let failure: Error | undefined;
    let deletionWindowId: number | undefined;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (operation === 'delete_mailbox') failure = error;
      else reject(error);
    };
    const timer = setTimeout(() => fail(new Error(
      readOnly
        ? `Mail timed out during ${operation}. This read-only request changed no messages. Check that Mail is responsive before retrying.`
        : 'Mail timed out. The action may have completed. Inspect Mail before retrying a write or send.',
    )), 45_000);
    const abort = () => fail(new Error('Request cancelled. An in-flight Mail action may have completed. Inspect Mail before retrying.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) fail(new Error('Mail response exceeded the size limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-2000);
      const marker = /MAILMCP_DELETE_WINDOW:(\d+)\n/u.exec(diagnostic);
      if (marker) deletionWindowId = Number(marker[1]);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    async function cleanupDeletion(): Promise<void> {
      if (operation !== 'delete_mailbox' || deletionWindowId === undefined) return;
      try {
        await callMail('cancel_mailbox_deletion', { ...args, windowId: deletionWindowId }, account, AbortSignal.timeout(5000));
      } catch { /* Do not confirm a dialog if Mail is unavailable. */ }
    }
    child.on('close', async code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) {
        if (failure) {
          await cleanupDeletion();
          reject(failure);
        }
        return;
      }
      if (code !== 0) {
        await cleanupDeletion();
        reject(new Error(`Mail automation failed (${code}). Check macOS Automation permissions. ${diagnostic}`));
        return;
      }
      try {
        const result = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (result.ok) resolve(result.data);
        else {
          await cleanupDeletion();
          reject(new Error(result.error));
        }
      } catch (error) {
        await cleanupDeletion();
        reject(error);
      }
    });
    if (!failed) child.stdin.end(JSON.stringify({ operation, args, account }));
  });
}
