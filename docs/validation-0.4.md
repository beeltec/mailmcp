# Mail analysis validation — 0.4.0

Validated on 26 September 2026 against live Apple Mail.
No automated tests were added.

## Original request replay

The baseline is Codex thread `01a0de2a-9580-7183-b978-eac47a44b718`.
The same user request was replayed without changing its wording.
It asks for unfinished tasks from two weeks of incoming mail, checked against sent replies.
The date range was 12–26 September 2026.

| Measure | Baseline | Final replay |
| --- | ---: | ---: |
| Mail tool calls | 158 | 34 |
| Search calls | 84 | 4 |
| Message-read calls | 71 individual calls | 14 batch calls |
| Relevant messages | 70 | Same 70 |
| Failed Mail tool calls | 7 | 0 |
| Request timeouts | 1 | 0 |
| Attachment saves | 0 | 14 |
| Wall time | About 5:07 | 5:27 |

The first three search calls covered the requested incoming and sent messages.
The fourth checked the rest of Sent for additional completion evidence.
All 70 relevant bodies were read without gaps, including body continuations.
Fourteen attachments were saved, and relevant customer files, flyer, and card PDFs were inspected.
The final answer explicitly identified other attachments as uninspected.

The final run took slightly longer overall because it included attachment inspection.
Fewer tool calls do not guarantee a shorter model response time.
No message bodies were shortened by the calling agent before analysis.
The largest Mail result contained 21,620 characters.
No mail was sent, moved, deleted, or marked through MCP during the replay.

Mail still rejects the Notes folder's message collection.
The batch returned this as a per-folder coverage gap while preserving other results.
The final answer reported that limitation.

## Iterations and reviews

Four replay attempts were made:

1. Read all 70 bodies. Found oversized body-budget errors and a test-session restriction on local attachment downloads.
2. Reproduced queue overload and timeouts. Stopped after recording these failures.
3. Reproduced a slow metadata read on imported folders. Stopped to improve that path.
4. Completed with no failed Mail tool calls, argument errors, or request timeouts.

Parallel GPT-6 Astra reviews covered correctness, coverage, cancellation, bounds, errors, and write safety.
Findings received GitHub issues and fixes. The final two review reports found no actionable defects.

Live profiling rejected two proposed optimizations:

- Native message counts were slower than bulk IDs. Later bulk counts also became slow, so discovery now reads no message collections.
- Native date predicates took 34 seconds for Inbox. Bulk date reads remain in use, with ID scans skipped for empty date ranges.

## Additional live checks

- Canonical discovery worked across all five configured accounts, including iCloud.
- Previously ambiguous Archive and drafts paths resolved to their actual folders.
- Inspector browser validation on the designated test account completed in 456 ms on the final build.
- A 33rd concurrent request returned a structured queue-capacity error.
- Cancelling 31 waiting requests freed their slots; a replacement request succeeded.
- A batch with two valid references and one stale reference preserved both valid results and returned one per-message error.
- Empty batches and invalid dates returned parseable `INVALID_REQUEST` JSON errors.
- Requested body budgets of 40,000 and body limits of 50,000 were capped to 16,000 and 12,000.
- Type checking, build, package dry run, and GitHub macOS CI passed.

Native Mail UI automation was unavailable in this session.
Computer-use checks used the live MCP Inspector browser UI instead.
Raw mail logs and attachment contents were kept out of the repository and pull request.
