# Mailbox CRUD validation

Validated on 2026-09-27 with the configured `cb@markveys.com` account and Apple Mail’s German interface.
No automated tests were added. No messages were sent during validation.

## Sorting through Codex

Two real runs used `codex exec -m gpt-6-sol --sandbox danger-full-access --json` with the configured Mail MCP.
The second run repeated the complete workflow after the deletion-dialog fixes.

| Live operation | Result | Second-run execution time |
| --- | --- | --- |
| Create a root and nested folder | Both appeared at their exact paths | 0.96–1.18 s |
| Inspect folders | Correct counts and direct child paths | Under 1 s |
| Move a disposable validation message into the child | Message-ID, read state, and flag preserved | 0.40 s |
| Rename the child and its parent | Messages and child paths preserved | 2.28–2.60 s |
| Move the validation message back | Original folder, Message-ID, read state, and flag verified | 0.38 s |
| Delete empty children, then the root | Temporary folders removed | 7.21–8.03 s |

The runs checked duplicate creation, missing parents, rename collisions, nonempty deletion, deletion with children,
protected Inbox/Trash operations, and invalid names. Each request was refused without the requested mutation.
Final discovery matched the original folders. The disposable message returned to its original Trash folder.

A third GPT-6 Sol run checked custom folders named `Sent` and `Archive` under a new parent.
It renamed the custom Sent folder and the parent, verified the children, and deleted the empty test folders.
The real root Sent mailbox refused renaming with `MAILBOX_PROTECTED`. Original folders remained unchanged.

## Interruption and synchronization

Additional live checks exercised the bridge and native Mail controls:

- Abort while the deletion confirmation is open: the confirmation closed and the empty folder survived.
- Move a disposable message into the folder after its confirmation opens: deletion stopped with `MAILBOX_NOT_EMPTY`.
  The confirmation closed, the message survived with its state unchanged, and it was restored to Trash.
- Cancel a deletion warning for a disposable parent with a child: both folders survived.
- Delete the resulting empty folders: cleanup succeeded.

Mail’s scripting delete command returned AppleEvent error -10000 during initial validation.
The implementation uses Mail’s Delete Mailbox control instead. It checks the exact viewer identifier, selected account and path,
localized confirmation title and message, button labels, and empty state before confirming.
Cancellation cleanup only dismisses a matching confirmation opened by the operation.

Deletion requires Accessibility and System Events Automation permission. These permissions were available on the test Mac.
Native CUA startup was unavailable; Mail controls were exercised live through System Events.
The 1,000-folder boundary was reviewed in code; the live account was not expanded to that size.
The checks cannot make Mail synchronization atomic. Do not sort concurrently while deleting folders.

## Build and review

Type checking, compilation, package inspection, and GitHub’s macOS build passed.
Parallel GPT-6 Astra reviews covered correctness and safety. Findings were tracked in GitHub issues and fixed on the feature branch.
Both final review reports found no actionable defects. The pull request remains open at the user’s request.
