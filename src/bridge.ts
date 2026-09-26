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
  const readOnly = ['discover_accounts', 'account_info', 'list_mailboxes', 'setup_mailboxes', 'search_messages', 'search_mailboxes', 'read_message', 'read_messages', 'get_draft'].includes(operation);
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = '';
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(error);
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
    child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-2000); });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) return;
      if (code !== 0) {
        reject(new Error(`Mail automation failed (${code}). Check macOS Automation permissions. ${diagnostic}`));
        return;
      }
      try {
        const result = envelope.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (result.ok) resolve(result.data);
        else reject(new Error(result.error));
      } catch (error) { reject(error); }
    });
    if (!failed) child.stdin.end(JSON.stringify({ operation, args, account }));
  });
}
