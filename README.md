# mailmcp

A local MCP server that controls Apple Mail through JavaScript for Automation.
It uses the accounts that are already configured in Mail. It does not need passwords.

## Requirements

- macOS with Apple Mail configured
- Node.js 22 or later
- Automation permission to control Mail
- Accessibility permission, only for `delete_mailbox`

## Install

```sh
npm install -g @beeltec/mailmcp
mailmcp setup
```

Setup lets you select:

1. The accounts the server can access
2. The Trash mailbox of each account (detected automatically when possible)
3. The tools the server offers (destructive tools are off by default)
4. The scope: user (all projects) or project (the current directory)
5. The harnesses to install the server in: Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, opencode, and pi

| Harness | User scope | Project scope |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `.mcp.json` (Code tab only) |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` (trusted projects only) |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` |
| opencode | `~/.config/opencode/opencode.json` | `opencode.json` |
| pi (with pi-mcp-adapter) | `~/.config/mcp/mcp.json` | `.mcp.json` |

Run setup in the project directory to use project scope. Project files contain absolute paths of your computer.
Run `mailmcp setup` again to change these settings. Restart the harness after changes.

To add the server manually:

```sh
codex mcp add mail -- /absolute/path/to/node /absolute/path/to/mailmcp/dist/cli.js
```

## Configuration

Setup writes `~/.config/mailmcp/config.json`. Set `MAILMCP_CONFIG` to use a different path.

```json
{
  "accounts": [
    { "id": "ACCOUNT-ID-FROM-SETUP", "email": "you@example.com", "trash": ["Trash"] }
  ],
  "tools": ["list_mailboxes", "search_messages", "read_message"]
}
```

Without `tools`, all tools are enabled. `list_accounts` is always enabled.
MCP tools cannot change the account allowlist.

## Tools

| Tools | Purpose |
| --- | --- |
| `list_accounts`, `list_mailboxes` | List allowed accounts and their mailboxes |
| `get_mailbox`, `create_mailbox`, `rename_mailbox`, `delete_mailbox` | Manage custom folders (delete only empty ones) |
| `search_messages`, `search_mailboxes` | Search by subject, sender, recipient, date, and unread state |
| `read_message`, `read_messages` | Read message bodies in pages and list attachments |
| `set_message_state` | Set read state or flag color |
| `move_message`, `trash_message` | Move a message within an account or into its Trash |
| `create_draft`, `reply_to_message`, `forward_message` | Create plain-text drafts |
| `get_draft` | Read a draft and get its revision for sending |
| `add_attachment`, `save_attachment` | Attach a local file or save a received attachment to a private folder in the OS temp folder |
| `send_draft` | Send a draft created in this session |

## Limits

- Drafts can only be sent from the server session that created them.
- `send_draft` needs the current revision from `get_draft`. Do not retry a timed-out send.
- mailmcp inserts the draft body through a temporary Mail signature, because Mail quotes text that a script sets directly. The draft window shows its name. Do not select another signature in such a draft, because Mail then replaces the body.
- Replies and forwards need Mail's setting "Place signature above quoted text" (on by default). Otherwise the body appears below the quoted original.
- mailmcp cannot read body edits made in the draft window. `send_draft` still detects a changed sender, subject, signature or recipient list.
- `add_attachment` works only with new drafts. Mail puts the attachment above the body. Forwards keep the original attachments.
- Search pages return at most 50 results. Follow `nextOffset` until it is `null`.
- Moves between accounts are not supported.
- Each request times out after 45 seconds. A timed-out write can still complete in Mail.
- After a timed-out draft request, a temporary `mailmcp draft body` signature can stay in Mail. mailmcp deletes it with the next draft in the same session. You can also delete it in Mail settings.

## Development

```sh
npm ci
npm run check
npm run build
npx @modelcontextprotocol/inspector node dist/cli.js
```

## License

MIT
