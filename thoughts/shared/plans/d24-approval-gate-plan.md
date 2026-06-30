# Plan: D2.4 — host-side approval gate for higher-stakes org-actions

## Overview

When the `org-actions` skill (D2.3) emits a `gated` action record, the host must
hold execution, post a host-rendered approval prompt to Slack, and execute the
action exactly once only after a distinct, fail-closed-allowlisted approver
approves. ADR-0002 (Accepted, 2026-06-06) is the contract; this plan implements
it against the verified state of `sagri-tokyo/nanoclaw` at the
`gog.4-approval-gate` worktree.

The load-bearing realisation from the survey: the host already holds
`NOTION_API_KEY` and `GITHUB_TOKEN` in its own `process.env` (used today by the
read-only `fetch-untrusted.ts` GETs at `src/fetch-untrusted.ts:551,579,599` and
the read-only Notion-query POST at `src/fetch-untrusted-list.ts:726`). Those
write-capable tokens reach the container *only* through the opt-in
`data/env/forward-list` mechanism (`src/env-forward.ts:7`, consumed at
`src/container-runner.ts:501-509`). So "remove the container's raw-curl
capability" is not new secret-storage work — it is *deleting two lines from the
forward-list* plus building host write clients that reuse the tokens already in
host `process.env`. This collapses the largest cost ADR-0002 anticipated.

## Verified findings (file:line, this worktree)

1. **No synchronous host MCP handler; tools are fire-and-forget file drops.**
   `container/agent-runner/src/ipc-mcp-stdio.ts:23-35,54-67` writes an IPC file
   and returns "Message sent." before any host involvement. The host drains
   later in `src/ipc.ts:85-200`. The IPC drain only knows `message` (`ipc.ts:122`)
   and the task verbs (`ipc.ts:256` switch). **There is no `notion`/`github`
   write IPC verb today** — confirmed by reading the full MCP tool list
   (`send_message`, `schedule_task`, `list_tasks`, `pause/resume/cancel/update_task`,
   `register_group`, `fetch_untrusted`, `fetch_untrusted_list`) at
   `ipc-mcp-stdio.ts:42-625`. So a gated `notion.*`/`github.*` action does NOT
   reach the host through an existing IPC verb; today it would run as raw
   `curl`/`gh` inside container Bash. This is the interception gap.

2. **The host owns the DB; non-main containers never mount it.** `messages.db`
   is mounted rw to main only (`src/container-runner.ts:158-163`); non-main
   groups get no store mount (`container-runner.ts:205-232`). The IPC drain
   (`src/ipc.ts`) is the one host context that owns the DB handle and performs
   the effect — the correct gate location, per ADR decision 1.

3. **No host write client exists.** Every Notion/GitHub host call is read:
   GETs at `fetch-untrusted.ts:552,580,600`, list GETs in
   `fetch-untrusted-list.ts`, and the single POST at
   `fetch-untrusted-list.ts:726` is a Notion *database query* (read), not a
   write. Confirmed by `grep method:` (only one POST, plus GETs). The host
   Notion/`gh` write clients are net-new (ADR decision 2 / finding 3).

4. **Container write capability is the forward-list, not the credential proxy.**
   The credential proxy is Anthropic-only (`src/credential-proxy.ts:64,94-96`,
   `tool: 'anthropic_api'`). Notion/GitHub writes in container Bash work *only*
   because `NOTION_API_KEY`/`GITHUB_TOKEN` are forwarded via the forward-list
   (`container-runner.ts:501-509`). Remove them there to cut the capability
   (ADR decision 3) — no egress-firewall work needed for v1, because without the
   token a raw `curl` to api.notion.com 401s.

5. **Bot/self detection drops `bot_id` at BOTH construction sites.**
   `src/channels/slack.ts:301` sets `is_bot_message: isOwnBotMessage`
   (`isOwnBotMessage = userId === botUserId`, `:245`) and discards
   `isSlackBotMessage = !!botId` (`:244`). The thread-history path repeats the
   flaw at `slack.ts:471` (`is_bot_message: isOwnBot`, no `botId`). `botUserId`
   is `undefined` until `auth.test()` resolves (`:316-318`). `NewMessage`
   (`src/types.ts:65-83`) has no `bot_id` field. This is the normative source-
   side fix (ADR decision 5).

6. **Kill-switch is the interception precedent.** `parseAbortIntent`
   (`src/abort-trigger.ts:48`) runs in the host inbound path
   (`src/inbound.ts:77`) *after* the sender-allowlist check (`inbound.ts:57-75`)
   and *before* `storeMessage` (`inbound.ts:88`). `handleAbort`
   (`src/index.ts:908-915`) acts host-side. The approval classifier slots in as
   a sibling of `parseAbortIntent`.

7. **The sender-allowlist is fail-OPEN.** `loadSenderAllowlist` returns
   `DEFAULT_CONFIG` (`allow: '*'`) on ENOENT, bad JSON, or invalid entry
   (`src/sender-allowlist.ts:42,47,54,63`). The approver allowlist here MUST be
   a separate, fail-CLOSED loader (ADR decision 5: distinct approver set).

8. **`reader-rpc.ts` is the synchronous host-RPC model.** `src/reader-rpc.ts:434`
   starts an HTTP server bound to the proxy host (loopback/docker0), container-
   reachable via `host.docker.internal` (wired at `container-runner.ts:462-466`,
   `NANOCLAW_READER_RPC_URL`), with scoped error codes and strict param
   validation. A host *write* RPC would mirror this shape if a synchronous deny
   to the agent were ever required (out of scope here — ADR decision 1 keeps the
   gate execution-withholding, not synchronous-deny).

9. **DB schema is migration-by-`ALTER`.** `src/db.ts:19-204` uses
   `CREATE TABLE IF NOT EXISTS` + idempotent `ALTER TABLE` in try/catch. A new
   `pending_actions` table follows that pattern. Atomic single-use consume is a
   conditional `UPDATE ... WHERE token=? AND state='approved'` checked via
   `better-sqlite3`'s `.changes === 1` (decision 4).

## Design

### Interception model (the load-bearing decision)

A gated action is made un-executable by the container in two coupled moves:

- **Capability removal (the real control).** Delete `NOTION_API_KEY` and
  `GITHUB_TOKEN` from `data/env/forward-list` so neither is in the container's
  Bash-reachable env. A raw `curl -X PATCH https://api.notion.com/...` then 401s;
  a `gh` call has no token. This is what makes the gate tamper-resistant, per
  ADR decision 3 and the negative-consequence note. (The container keeps a
  read path: reads go through the host `fetch_untrusted` RPC, which uses the
  host's own token — the container never needs the raw write token for reads.)

- **Host execution path (the only way the effect can happen).** A new IPC verb
  `org_action` is added to the in-container MCP server
  (`ipc-mcp-stdio.ts`): the skill's gated branch drops an `org_action` IPC file
  carrying `{action, target_ref, reversibility, stakes_hint, citation_refs,
  canonical_args}` and returns the honest ADR string
  `submitted; held pending approval — do not proceed`. The host drains it in
  `src/ipc.ts` (new `case 'org_action'`), re-classifies host-side, and either
  executes immediately (safe) or holds (gated). Because the container has no
  write token, the host `org_action` path is the *only* route to the effect —
  the agent cannot bypass it.

This resolves the "write tokens are container-reachable" problem both ADR-0002
and the D2.3 design flag: the skill emits a request, the host owns the token and
the execution.

### Host-side write clients (net-new, named scope)

A new module `src/org-action-clients.ts` provides the minimal write surface the
v1 action table needs, reusing the tokens already in host `process.env`
(`requireEnv('NOTION_API_KEY')` / `requireEnv('GITHUB_TOKEN')`, same accessor
`fetch-untrusted.ts` uses):

- `notionAppendProgress(pageId, blocks)` — `PATCH /v1/blocks/{id}/children`
- `notionWriteProperty(pageId, props)` — `PATCH /v1/pages/{id}`
- `notionCreateTask(databaseId, props)` — `POST /v1/pages`
- `githubFileIssue(repo, title, body)` — `gh issue create` (spawn) against the
  single allowlisted repo
- `githubOpenDraftPr(repo, branch, title, body)` — `gh pr create --draft`
- `slackPostDigest(channelId, text)` — reuse the existing `send_message` path
  (no new client; host already owns the Slack token)
- `docDraft(databaseId, props)` — Notion draft page via `notionCreateTask`

All HTTP write calls go through the existing SSRF-guarded fetcher
(`fetchWithRedirects`/`resolveDeps` in `fetch-untrusted.ts`) so the host write
path inherits the public-address / redirect-revalidation guards.

### Host classifier + allowlist (authoritative)

A new `src/org-action-gate.ts` host-mounts the D2.3 Decision-6 allowlist (the
gated `tool+target` table) from a tamper-proof config path
(`~/.config/nanoclaw/org-action-allowlist.json`, sibling of the mount/sender
allowlists at `config.ts:36-47`, NOT mounted into any container). It exposes:

- `classifyOrgAction(record): 'execute' | 'hold' | 'refuse'` — re-applies the
  red-line refusal table (mrv/carbon/jichitai/自治体/prod), the github single-
  repo allowlist, and the gated rules (lifecycle-status flip, cross-channel
  digest). The container's `stakes_hint` is advisory and ignored for the
  decision (ADR: never trust the container's classification).
- `renderApprovalSummary(record): string` — deterministic, host-side, from
  `action + target_ref + canonical_args` only, never agent prose (decision 4).

The red-line and id-shape checks are re-run host-side even though the skill
already ran them, because the host must never trust the container's classification.

### Pending-approval state model

New table (migration in `src/db.ts`, following the `ALTER`/`IF NOT EXISTS`
pattern at `db.ts:19-204`):

```sql
CREATE TABLE IF NOT EXISTS pending_actions (
  token TEXT PRIMARY KEY,            -- host-minted, >=256-bit base64url (43 chars)
  source_group TEXT NOT NULL,        -- the IPC sourceGroup that requested it
  chat_jid TEXT NOT NULL,            -- channel the approval prompt posts to
  action TEXT NOT NULL,              -- one of the 7 fixed action rows
  target_ref TEXT NOT NULL,          -- constrained id
  canonical_args TEXT NOT NULL,      -- JSON, the exact args the host will replay
  summary TEXT NOT NULL,             -- host-rendered approver-facing text
  state TEXT NOT NULL,               -- 'pending' | 'approved' | 'consumed' | 'denied' | 'expired'
  requester TEXT NOT NULL,           -- requesting GROUP FOLDER (NOT a user id); see separation-of-duty scope note
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- created_at + TTL
  approved_by TEXT,                  -- approver sender id, set on approve
  consumed_at TEXT                   -- set on the single-use consume
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_state ON pending_actions(state, expires_at);
```

- **Host-only minting**: `crypto.randomBytes(32).toString('base64url')`. The
  token is written only to `messages.db` and the host-posted Slack text — never
  into any agent-readable IPC/tasks file (the agent has no IPC verb that reads
  the store, and non-main containers cannot mount it; verified findings 1-2).
- **Atomic single-use consume**:
  `UPDATE pending_actions SET state='consumed', consumed_at=? WHERE token=? AND state='approved'`,
  executed only if `.changes === 1` (same host process, same DB handle as the
  classifier that set `approved` — no cross-process gap).
- **Terminal reject**: `reject <token>` sets `state='denied'`; the approve path
  refuses any transition out of `denied`/`consumed`/`expired`. (The operator
  keyword is `reject`; the internal state and DB accessor use `denied`/`deny`.)
- **TTL + expiry**: a sweep (folded into the existing IPC poll or a small
  interval) marks `state='pending' AND expires_at < now` as `expired`. The TTL
  value is an OPEN QUESTION (ADR open question 1) — proposed default below,
  pending the user's red-line decision.
- **Boot re-drive**: on startup, re-scan `pending_actions WHERE state='approved'`
  and replay each via the atomic consume (decisions-recorded #2). A row that
  expired before the restart is NOT re-driven — silent loss, flagged as the open
  question.

### Approval round-trip

- **Prompt** (host-rendered, posted via the channel that owns `chat_jid`):
  shows action, target_ref, reversibility, the host-rendered summary, the
  citation_refs, and the 43-char token with the literal `approve <token>` /
  `reject <token>` instruction. No Block Kit (decision 7, deferred behind the
  emit/capture seam).
- **Capture**: a new `parseApprovalIntent(content)` classifier
  (`src/approval-trigger.ts`, modelled on `abort-trigger.ts`), whole-message
  anchored: `^approve\s+<43-char-token>$` / `^deny\s+<token>$`. Wired into
  `src/inbound.ts` as a sibling of `parseAbortIntent`, AFTER the sender-allowlist
  drop check and the abort check, BEFORE `storeMessage`.
- **Approver ACL (fail-CLOSED)**: a distinct `loadApproverAllowlist()`
  (`src/approver-allowlist.ts`) that returns an EMPTY set (deny-all) on ENOENT /
  bad JSON / invalid entry — the inverse of the fail-open sender-allowlist
  (finding 7). The handler rejects unless `msg.sender ∈ approvers`, rejects
  `is_from_me || is_bot_message`, rejects `requester === approver`, and refuses
  to classify at all while `botUserId` is unresolved (treat unresolved as deny).

  **Separation-of-duty scope (true property, not the aspiration).** The
  `requester === approver` reject is GROUP-LEVEL only. `requester` holds the
  requesting group folder, never the triggering Slack user id — that id is not
  available at the `org_action` IPC drain: the container is launched per group
  on a BATCH of laundered messages (potentially several senders), and the MCP
  tool that emits the request runs inside the container with only the group
  folder as identity, so no user id is forwarded into the container or the
  request. Consequently this check can never be a user-level "the requesting
  human cannot self-approve" guard (a group-folder string and a Slack user id
  never collide); it only excludes the degenerate case where the approver
  allowlist itself names a group-folder string. The actual dual-control property
  that holds today is: an action executes only after an **allow-listed approver
  who is not a bot/self** authorizes it. Real user-level dual control would
  require new plumbing to carry the triggering sender id through container
  launch into the org_action request, tracked in sagri-tokyo/sagri-ai#296.
- **Bot/self source fix (normative, ADR decision 5)**: set
  `is_bot_message = isOwnBotMessage || !!botId` at BOTH `slack.ts:301` and the
  thread-history path `slack.ts:471`.

### Replay / execution

On `approve <token>`: validate approver, transition `pending -> approved`, then
run the atomic consume; on `.changes === 1`, re-run `classifyOrgAction` on the
persisted record (re-check red lines + constrained ids host-side, never trust
the original classification), then dispatch to the matching
`org-action-clients.ts` writer with the persisted `canonical_args`. The consume-
before-execute ordering plus the `WHERE state='approved'` guard makes execution
exactly-once even under a double-approve or a boot re-drive race.

### Dependencies

- Internal: `src/ipc.ts` (new `org_action` case + drain-time classify/hold),
  `src/db.ts` (table + accessors), `src/inbound.ts` (classifier wiring),
  `src/index.ts` (handleApproval, boot re-drive, TTL sweep), `src/channels/slack.ts`
  (bot/self fix, both sites), `data/env/forward-list` (token removal).
- New modules: `org-action-gate.ts`, `org-action-clients.ts`, `approval-trigger.ts`,
  `approver-allowlist.ts`.
- External: Notion API (`api.notion.com`), GitHub (`gh` CLI / `api.github.com`),
  Slack (existing send path). No new external dependency, no new secret store.

## Phases

Each phase is independently mergeable and reversible.

### Phase 1: pending_actions table + atomic consume + accessors (S/M)
- Files: `src/db.ts`, `src/db.test.ts`.
- Interface: `createPendingAction(row)`, `getPendingAction(token)`,
  `approvePendingAction(token, approverId)`, `consumePendingAction(token)` (atomic,
  returns boolean from `.changes===1`), `denyPendingAction(token)`,
  `expirePendingActions(now)`, `getApprovedUnconsumed()`.
- Acceptance: table created idempotently; consume returns true exactly once and
  false on every subsequent call; deny is terminal (approve-after-deny is a no-op);
  expire only touches `pending` rows; all covered by in-memory-DB tests
  (`_initTestDatabase`).
- Size: S/M. Pure host, no live deps.

### Phase 2: host classifier + host-rendered summary (M)
- Files: `src/org-action-gate.ts`, `src/org-action-gate.test.ts`,
  config-examples for `org-action-allowlist.json`.
- Interface: `classifyOrgAction(record): 'execute'|'hold'|'refuse'`,
  `renderApprovalSummary(record): string`, `loadOrgActionAllowlist(path?)`.
- Acceptance: red-line target -> refuse; github non-`sagri-tokyo/sagri-ai` ->
  refuse; lifecycle-status flip to `Ready for AI`/`Approved` -> hold;
  cross-channel digest -> hold; the safe rows -> execute; summary derives only
  from action+target+canonical_args (a record with adversarial prose in an
  unrelated field renders identically). Mirrors the D2.3 Decision-6 table.
- Size: M. Pure host, fixture-tested.

### Phase 3: bot/self source fix + approver allowlist + approval classifier (M)
- Files: `src/channels/slack.ts` (both construction sites), `src/approver-allowlist.ts`,
  `src/approval-trigger.ts`, plus `.test.ts` for each.
- Interface: `parseApprovalIntent(content): {kind:'approve'|'deny', token} | null`,
  `loadApproverAllowlist(path?): Set<string>` (fail-CLOSED empty on any error),
  `isApprover(sender, set): boolean`.
- Acceptance: `is_bot_message` true for any `bot_id` message at both sites;
  classifier matches only whole-message `approve <43-char>` / `reject <token>`,
  rejects a human quoting the prompt; approver loader returns empty set on
  ENOENT/bad-JSON; `is_from_me`/`is_bot_message` rejected; unresolved `botUserId`
  treated as deny.
- Size: M. Pure host, unit-testable.

### Phase 4: host write clients (M/L)
- Files: `src/org-action-clients.ts`, `src/org-action-clients.test.ts`.
- Interface: the seven writers above, each taking `canonical_args` and returning
  a typed result (or throwing, fail-fast). HTTP writes go through the existing
  SSRF-guarded fetcher; `gh` writes via `spawn` with arg arrays (never shell
  interpolation).
- Acceptance: each writer hits the correct endpoint/verb with the token from
  host `process.env`; github writers refuse any repo != `sagri-tokyo/sagri-ai`
  and always pass `--draft` for PRs (never `gh pr ready`/merge); tests use a
  recorded/replayed transport (per repo test conventions — no hand-rolled mock
  of the Notion/GitHub API beyond the smallest fetch seam).
- Size: M/L. Largest single piece, but bounded by the closed 7-row table.

### Phase 5: IPC org_action verb + drain-time gate + execution (M/L)
- Files: `container/agent-runner/src/ipc-mcp-stdio.ts` (new `org_action` tool),
  `src/ipc.ts` (new `case 'org_action'`: classify -> execute-now |
  mint-token-hold-post | reject), `src/ipc.test.ts`, `src/index.ts`
  (`handleApproval`, boot re-drive of approved-unconsumed, TTL sweep wiring),
  `src/inbound.ts` (classifier wiring), `data/env/forward-list` (remove the two
  tokens).
- Interface: `org_action` MCP tool (Zod-constrained drop, returns the honest
  held string); `handleApproval(chatJid, msg)` in `index.ts`.
- Acceptance: a gated `org_action` IPC file is held (row written, Slack prompt
  posted, NO effect); `approve <token>` from an allow-listed approver executes
  the persisted args exactly once (second approve is a no-op); `deny` drops it
  terminally; an expired token cannot be approved; boot re-drive replays an
  approved-unconsumed row; the container with the tokens removed from the
  forward-list cannot perform a raw-curl write (capability gone). Fail-closed
  tests: gate does not execute with the store locked / on classifier error.
- Size: M/L. The first *enforcing* increment is Phases 1+2+4+5 together with at
  least one host write-client migrated (ADR acceptance bar).

### Phase 6: Block Kit one-click (DEFERRED — separate ADR)
- Not in this plan. The emit/capture seam (Phases 3+5) is built so a later
  `app.action` handler swap touches only those two points (ADR decision 7).

## The split: fork vs overlay, and the deploy dependency

- **nanoclaw fork (this worktree)**: everything above — Phases 1-5. The gate,
  table, classifier, write clients, IPC verb, bot/self fix, forward-list edit.
- **sagri-ai overlay**: the D2.3 skill already emits the gated record and the
  honest held string (`skills/org-actions/SKILL.md` `emit_action_record`, exit 2).
  The overlay change is small: the skill's gated branch drops the `org_action`
  IPC file instead of stopping at the seam. The host `org-action-allowlist.json`
  is operator config on the instance (the D2.3 Decision-6 table, host-mounted).
- **Instance-replacement dependency**: the forward-list edit and the new host
  code land on the EC2 instance only on the next instance replacement
  (user-data overlay + image rebuild), per the deploy model in CLAUDE.md. The
  gate is not live until that replacement. Until both the host execution path
  AND the forward-list removal are deployed, "tamper-resistant" does not apply
  (ADR negative consequence) — sequence them in the same replacement.
- **Unit-testable on the host (no live stack)**: Phases 1-4, and the
  classify/hold/consume logic of Phase 5. **Needs a live Slack round-trip**: the
  end-to-end approve/deny against the prod workspace and the live Notion/`gh`
  write — the D2.6 demo script.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Forward-list removal breaks a read path that relied on the container's token | Read skills 401 | Reads already route through the host `fetch_untrusted` RPC (host token); audit each skill for a residual direct-token read before removing, and give any legitimate reader a read-scoped credential, never the write token (ADR decision 3) |
| TTL expiry silently loses a red-line approval | A real approval is dropped | OPEN QUESTION below; default 24h + log on expiry until resolved; do NOT rely in prod on the red lines until the user rules |
| Token leaks into an agent-readable surface | Agent self-approves | Token only in `messages.db` + host Slack text; agent has no store-reading IPC verb and non-main containers don't mount the store (findings 1-2); add a test asserting no IPC/tasks file ever contains a token |
| Approver-allowlist file missing on the instance | fail-CLOSED denies all approvals | Intended (inverse of sender-allowlist); document the config path in the runbook and verify on deploy |
| `gh`/Notion write client arg injection | Unsafe write | `spawn` with arg arrays (no shell); re-run the constrained-id traversal/shape guard host-side before any argv interpolation |
| Double-execute under boot re-drive + a late approve | Action runs twice | Atomic consume `WHERE state='approved'` + `.changes===1` is the single gate; re-drive uses the same consume |

## Open questions (require user decision)

- **Approval-token TTL value, and expiry-vs-boot-re-drive for the red lines**
  (ADR open question 1). A token that expires before a host restart is not
  re-driven, so the approval is silently lost. Is silent loss acceptable for
  MRV/carbon/jichitai/prod, or must expiry surface a re-request to the approver?
  Resolve before the gate is relied on in production. Proposed interim: 24h TTL,
  log-on-expiry, no auto-re-request — pending the ruling.
- **Approver set membership**: who is in the fail-closed approver allowlist, and
  is requester != approver required for ALL gated actions or only the red-line
  tiers? (ADR decision 5 requires it for the red lines; confirm the broader
  policy.) NOTE: user-level requester != approver is NOT enforceable today —
  the triggering user id is not available at the drain (see the separation-of-
  duty scope note above). The follow-up to plumb the sender id through container
  launch must land before any user-level requester != approver claim is relied
  on.

## Success criteria

- A gated `org_action` is held: a `pending_actions` row exists, a host-rendered
  Slack prompt is posted, and NO effect runs (verified: the target page/issue is
  unchanged).
- `approve <token>` from an allow-listed approver executes the persisted args
  exactly once; a second `approve` is a no-op; `deny` drops it terminally; an
  expired or denied token can never be approved.
- The container, with `NOTION_API_KEY`/`GITHUB_TOKEN` removed from the
  forward-list, cannot perform a raw-curl write (capability removed) — the host
  `org_action` path is the only route to the effect.
- The approval summary is host-rendered from canonical args, identical under
  adversarial agent prose in the record.
- Fail-closed properties have tests: deny-all approver allowlist on missing
  config; gate does not execute with the store locked or on classifier error.
- D2.6 demo: one gated action held, approved by a distinct approver, executed
  exactly once, live against the prod Slack workspace and the live Notion DB.

## Integration details

| Aspect | Value |
|---|---|
| External: Notion | base `https://api.notion.com/v1`, `Authorization: Bearer ${NOTION_API_KEY}` (host env), `notion-version` header; writes: `PATCH /pages/{id}`, `PATCH /blocks/{id}/children`, `POST /pages` |
| External: GitHub | `gh` CLI (token `GITHUB_TOKEN`, host env) or `api.github.com`; `gh issue create`, `gh pr create --draft` only; repo allowlist `sagri-tokyo/sagri-ai` only |
| External: Slack | existing host send path; approval prompt + capture via the inbound classifier; no new scope |
| Credential location | host `process.env` (already present), NOT forwarded to the container after the forward-list edit |
| Idempotency | atomic single-use consume `UPDATE ... WHERE token=? AND state='approved'`, `.changes===1` |
| Retry/backoff | host write client failures fail-fast (no silent retry); a failed replay leaves the row `approved` so a manual re-approve or boot re-drive can retry; surface the failure to the approver channel |
| Transport | reply-keyword (`approve <token>` / `reject <token>`), whole-message anchored, host-classified, human-only; Block Kit deferred behind the emit/capture seam |
