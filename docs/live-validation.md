# Live validation

Checked on macOS 26.6.2 with Apple Mail and Node.js 24.13.1.
All mail writes used disposable, self-addressed messages in the account selected for this task.
Mail workflows were checked through the browser interface of MCP Inspector 2.8.0.
Results were also inspected through Apple Mail's native interface.

## Observed results

- Interactive setup selected one account and its Trash mailbox.
- `list_accounts` exposed only that account. An unconfigured account ID was rejected.
- Draft creation preserved Unicode, quotes, the selected sender, and the recipient.
- A text attachment was visible in Mail's composer.
- The send tool reported acceptance. The self-addressed message then arrived in the inbox.
- The received text and attachment metadata were read through MCP.
- The saved attachment matched the original file byte for byte.
- Read state and flags changed as requested.
- Moving the message changed its local numeric ID. The old reference was rejected.
- Trash-only deletion moved the message into the configured Trash mailbox.
- Native reply creation retained the supplied body. The reply arrived and Mail grouped it with the original message.
- A second send attempt using the consumed handle was rejected.
- Text forward creation retained the supplied body and original text.
- Test drafts, incoming messages, and sent copies were moved into Trash through Mail. Trash was not emptied.
- Inspector cancellation returned a cancellation notice. The connection accepted the next request.
- Direct protocol checks confirmed cancellation for request ID zero and clean shutdown on stdin EOF and SIGTERM.

## Mail limitations found during checks

- Direct assignment to an open draft's content can silently fail. This version creates drafts but does not expose body replacement.
- Native reply bodies require setting the properties record. The bridge checks that the supplied body was retained.
- Mail may change inline attachment markers and trailing whitespace after saving. Preview comparisons normalize those differences.
- Mail could not provide the received attachment's MIME type. The tool returns `null` for that optional field.
- Open-draft attachments cannot be reliably enumerated. The composer must be checked before sending.
- Text forwards do not preserve original attachments automatically. The separate save/add tools provide that operation.

## Build checks

`npm run check`, `npm run build`, and `npm pack --dry-run` passed.
The packed package installed locally and its CLI started successfully.
No automated tests were created.
