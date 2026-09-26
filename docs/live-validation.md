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

## Search regression validation: version 0.2

Investigated the reported Codex session and reproduced its date-only, oversized-page arguments.
The affected account had 6,316 inbox messages and 1,987 sent messages during validation.
Individual inbox index lookups took about 4.5 seconds per field before the change.
Search now uses bulk metadata and direct message IDs. It does not read all message bodies or Message-ID headers.

Final browser runs through MCP Inspector returned:

| Operation | Observed time | Result |
| --- | --- | --- |
| Original inbox query with date-only input, limit 100, and scanLimit 1000 | 1.58 seconds | 50 of 56 matches |
| Continuation at offset 50 | 1.22 seconds | Remaining six matches; no next page |
| Sent recipient search over the same dates | 1.91 seconds | 13 matches |

These are local observations, not timing guarantees. Mail load and synchronization can affect response time.
Direct live MCP checks also covered:

- Complete pagination with no duplicates and descending received dates.
- Equivalent UTC, explicit-offset, and timezone-free date inputs.
- Inclusive lower and exclusive upper date boundaries.
- Case-insensitive text matching and complementary read/unread filters.
- Empty mailboxes, no matches, and offsets beyond the last result.
- Invalid calendar dates, reversed date ranges, negative limits, missing mailboxes, unknown accounts, and stale references.
- Reading a returned message reference without changing its read state.
- Broad recipient searches without a date bound: 1,678 matches, with pages returned in 1.97 and 1.53 seconds.
- Cancellation after 102 milliseconds, followed by another successful call on the same connection.
- Separate To, Cc, and Bcc matches using a disposable unsent draft in the designated test account.

The draft's recipients were inspected in native Mail. The draft was moved into Trash; it was never sent.
No real messages were moved or edited during this regression check.

## Automatic Trash setup validation: version 0.3

- Ran the complete interactive setup against five live Mail accounts, saving to a temporary configuration file.
- Every Trash path was detected without a folder prompt: `Deleted Messages`, `Trash`, or `Papierkorb`.
- The generated configuration matched the user's existing configuration exactly. The user's configuration was not overwritten.
- Repeated live mailbox discovery and selection after the accountless-mailbox handling fix.
- Exercised the interactive fallback with Gmail's real mailbox list and assignment metadata omitted.
  Its `Papierkorb` and `Deleted Messages` candidates triggered a prompt; selecting `Papierkorb` returned the exact path.
- Manually exercised the terminal selector with localized names, a Unicode-width variant, and a Gmail namespace.
  The selected paths retained their original spelling.
- `Archive / Trash` and `Trash backup` did not trigger automatic name matching.
  An invalid manual selection was rejected.

These checks did not send, move, delete, or read any messages. No automated test files were added.

## Select-all setup validation

- Ran interactive setup with `  aLl  ` and selected the sender address for the account with aliases.
- All five accounts were included, and Trash detection completed without a folder prompt.
- The temporary result matched the current configuration. The active configuration was not overwritten.
- Ran numbered selection with a duplicate number; the requested account appeared only once.
- Entered `All,3` and verified rejection without changing the previously saved temporary configuration.

No messages were changed and no automated tests were created.
