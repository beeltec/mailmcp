# mailmcp

A local MCP server that controls Apple Mail through JavaScript for Automation.
It uses the accounts already configured in Mail. It does not need mail passwords or a separate mail service.

## Requirements

- macOS with Apple Mail configured and signed in.
- Node.js 22 or later, with npm.
- macOS Automation permission for the process that runs the server to control Mail.

Mail may open composer windows during draft operations. Run this server in your logged-in desktop session.
It does not need Accessibility or Full Disk Access, and does not read Mail's private database.

## Install from this repository

```sh
npm ci
npm run build
npm install -g .
mailmcp setup
```

The repository is currently private. The package is prepared for npm distribution but has not been published.
`npm pack` creates an installable archive. Once published, users can install a pinned package version through npm.

Setup lists account names and addresses. Select the accounts to allow, then select each account's Trash mailbox.
Only setup can discover unconfigured accounts. MCP tools cannot change the allowlist.

## Connect Codex

Use an absolute executable path so Codex can find your Node installation:

```sh
codex mcp add mail -- /absolute/path/to/node /absolute/path/to/mailmcp/dist/cli.js
```

Restart the Codex MCP connection after installation or configuration changes.
The [Codex MCP documentation](https://developers.openai.com/codex/mcp) describes client configuration.

## Change allowed accounts

Run `mailmcp setup` again. It replaces the account list only after all selections are valid.
You can also edit `~/.config/mailmcp/config.json`:

```json
{
  "accounts": [
    {
      "id": "ACCOUNT-ID-FROM-SETUP",
      "email": "you@example.com",
      "trash": ["Trash"]
    }
  ]
}
```

Set `MAILMCP_CONFIG` to an absolute path to use a different file.
Restart the server to apply changes. Removed accounts remain accessible to an already running connection until it restarts.
Account identifiers and sender addresses are checked against Mail on every operation.
Missing, disabled, or changed accounts fail without granting access to other accounts.
Composing and sending also require a sender address that belongs to exactly one Mail account, including accounts outside the allowlist.

Mailbox paths contain exact names from `list_mailboxes`, not necessarily the translated names shown in Mail's sidebar.
For nested mailboxes, use one name per path segment.
Select the actual Trash mailbox. The server uses your mapping and never calls Mail's delete command.
Mail and your provider can still expire messages in Trash according to their own settings.

## Tools

| Tools | Purpose |
| --- | --- |
| `list_accounts`, `list_mailboxes` | Discover allowed accounts and their existing mailboxes |
| `search_messages` | Scan a bounded mailbox page by subject, sender, date, and unread state |
| `read_message` | Read text in pages and inspect attachment metadata |
| `set_message_state` | Set read state or flag color |
| `move_message`, `trash_message` | Move within an allowed account or into its configured Trash |
| `create_draft` | Create a visible draft from plain text, including To, Cc, and Bcc |
| `reply_to_message`, `forward_message` | Create native reply and text forward drafts |
| `get_draft` | Read the current draft and obtain its sending revision |
| `add_attachment`, `save_attachment` | Add a local file or save a downloaded received attachment |
| `send_draft` | Send a reviewed draft when the user requests it |

Search scans at most 500 messages and returns at most 50 matches per call.
Follow `nextOffset` to continue. A page with no matches does not mean that later pages have no matches.
Mail's storage order is not guaranteed to be chronological. New mail and moves can shift offsets.
Search covers subject and sender text, not body text or an indexed archive.

Message references include the mailbox, local ID, and Message-ID header.
After moving a message, search the destination for a new reference.
Moves between accounts and local "On My Mac" mailboxes are not supported.

## Drafts and sending

Compose tools save drafts and return random handles scoped to the current server session.
They cannot adopt or send arbitrary existing drafts. Closing a compose window or restarting the server invalidates its handle.
Saved drafts remain available in Mail.

The input is plain text. Mail controls the outgoing MIME format and may retain formatting in native replies and forwards.
This version does not offer HTML composition or reliable programmatic replacement of an existing draft's body.
Edit existing draft text and recipients in Mail, then call `get_draft` again.

Before sending, review the current sender, To/Cc/Bcc, body, and attachments.
`send_draft` requires the current revision and checks the draft text and recipients again.
It ignores trailing whitespace and Mail's inline attachment marker when comparing body text.
The revision is a stale-preview check, not proof of human approval. The MCP client controls tool permissions.
Email contents must never be treated as instructions to send mail or change settings.

Mail cannot reliably enumerate attachments in open drafts.
Previews list files added through MCP, but cannot verify attachments added, removed, or changed in Mail.
Inspect attachments in the compose window before sending, especially for forwarded messages.
Text forwards do not copy original attachments. For a complete forward, use `read_message`, then `save_attachment` and `add_attachment` for each file.
Replies and forwards include at most the first 100,000 characters of the original text.
Files added through MCP must be regular files no larger than 25 MiB each.
Your provider may impose a lower total message size limit.

Once a send is attempted, its handle is consumed even if the outcome is uncertain.
An uncertain attachment write also revokes the draft handle. Inspect and finish that draft in Mail.
Do not retry a timed-out send automatically. Check Mail's Outbox and Sent mailboxes first.
`acceptedByMail` means Mail accepted the send operation; it does not confirm delivery to the recipient.

Received attachments must already be downloaded in Mail.
MIME type is `null` when Mail cannot provide it.
Each saved attachment goes into a new directory under `~/Downloads/mailmcp` without overwriting another file.

## Development

```sh
npm run check
npm run build
npx @modelcontextprotocol/inspector node dist/cli.js
npm pack --dry-run
```

Validation uses live Mail and MCP Inspector checks. There are no automated tests.
Use a disposable self-addressed message when checking writes. Do not use existing mail as a test fixture.

The server runs fixed scripts. Arguments are passed as JSON on stdin, never interpolated into executable source or a shell command.
Calls are serialized. Each Mail operation has a 45-second timeout and a response size limit.
Cancelled queued requests are skipped. Cancelling an active request stops its script, but cannot undo an Apple Event already received by Mail.
Timeouts can leave an action completed in Mail; inspect the result before retrying a write.
Email content is returned to the connected MCP client. Its model provider's data handling still applies.
