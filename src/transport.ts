import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CancelledNotificationSchema, type JSONRPCMessage, type RequestId } from '@modelcontextprotocol/sdk/types.js';

export class MailTransport extends StdioServerTransport {
  private readonly requests = new Map<RequestId, AbortController>();
  private readonly shutdown = new AbortController();
  private readonly stop = () => { void this.close(); };

  override async start(): Promise<void> {
    const receive = this.onmessage;
    this.onmessage = message => {
      if (this.shutdown.signal.aborted) return;
      if ('method' in message && message.method === 'tools/call' && 'id' in message) {
        this.requests.set(message.id, new AbortController());
      }
      const cancellation = CancelledNotificationSchema.safeParse(message);
      if (cancellation.success && cancellation.data.params.requestId !== undefined) {
        this.requests.get(cancellation.data.params.requestId)?.abort();
      }
      receive?.(message);
    };
    process.stdin.once('end', this.stop);
    process.once('SIGINT', this.stop);
    process.once('SIGTERM', this.stop);
    await super.start();
    if (process.stdin.readableEnded) await this.close();
  }

  signal(id: RequestId, signal: AbortSignal): AbortSignal {
    const request = this.requests.get(id);
    return AbortSignal.any([signal, this.shutdown.signal, ...(request ? [request.signal] : [])]);
  }

  finish(id: RequestId): void {
    this.requests.delete(id);
  }

  override async send(message: JSONRPCMessage): Promise<void> {
    if (!('method' in message) && 'id' in message && message.id !== undefined) this.finish(message.id);
    if (!this.shutdown.signal.aborted) await super.send(message);
  }

  override async close(): Promise<void> {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort();
    this.requests.clear();
    process.stdin.off('end', this.stop);
    process.off('SIGINT', this.stop);
    process.off('SIGTERM', this.stop);
    await super.close();
  }
}
