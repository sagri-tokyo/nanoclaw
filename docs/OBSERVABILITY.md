# NanoClaw Observability

Activity-log model for NanoClaw. Every tool invocation, dispatch, and state transition is emitted as a single-line JSON record via `logger.action()` (`src/logger.ts`). The record shape is fixed and runtime-validated; any drift fails fast at the call site rather than producing partial records.

In production, container stdout/stderr is shipped to CloudWatch Logs group `/sagri-ai/openclaw-prod` (the prefix is preserved from the OpenClaw era). The dashboards and queries below run against that group.

## Schema

Twelve fields, all required, no unknown keys permitted. Defined as `ActionRecord` in `src/logger.ts` with `validateActionRecord` as the closed-schema gate.

| Field | Type | Semantics |
| --- | --- | --- |
| `ts` | string | ISO 8601 UTC timestamp; matches `new Date().toISOString()`. Millisecond precision optional. |
| `level` | string | One of `info`, `warn`, `error`. Routes the line to stdout (`info`) or stderr (`warn`/`error`). |
| `session_id` | string | Stable identifier for the unit of work. Per-surface convention — see the catalogue below. Non-empty. |
| `trigger` | string | Top-level surface that started the work. Current values: `slack`, `scheduled`, `sub_request`, `ipc`. Non-empty. |
| `trigger_source` | string | Where on the surface it came from: a Slack channel id, a task name, a redacted upstream path, an IPC client id. Non-empty. |
| `tool` | string | The action being performed. See the catalogue below. Non-empty. |
| `inputs_hash` | string | sha256 of the canonicalised input. 64-char lowercase hex. |
| `outputs_hash` | string | sha256 of the canonicalised output. 64-char lowercase hex. Empty/missing output hashes the empty string. |
| `duration_ms` | number | Wall-clock duration of the action, milliseconds. Non-negative finite number. |
| `outcome` | string | One of `ok`, `error`, `timeout`, `rejected`. `rejected` covers authorisation/validation refusals; `error` is reserved for runtime failures with a populated `error_class`. |
| `error_class` | string \| null | Constructor name (or HTTP status sentinel for `sub_request`) when `outcome=error`. MUST be a non-empty string when `outcome=error`, and `null` otherwise. The key is required — omission throws. |
| `group` | string | Logical owner of the action. Usually the NanoClaw group folder; for `slack/message_send` it is the Slack JID, for `sub_request/anthropic_api` it is the synthetic value `credential-proxy`, for `sub_request/reader_rpc` it is the reader source name. Non-empty. |

The validator rejects: missing keys, unknown keys, wrong types, non-finite or negative `duration_ms`, hashes that don't match `/^[0-9a-f]{64}$/`, `outcome=error` with empty `error_class`, and any string field whose value contains `process.env.ANTHROPIC_API_KEY` as a substring (defence-in-depth secret leak guard).

## Hashing rules

`hashPayload` (`src/logger.ts`) is the single hashing primitive for both `inputs_hash` and `outputs_hash`.

- Algorithm: sha256.
- Encoding: bare lowercase hex, 64 characters. No `sha256:` prefix, no salt, no truncation.
- Buffers and `Uint8Array` are hashed as raw bytes. Strings are hashed as UTF-8 bytes.
- Everything else is canonicalised via `canonicalJson` then hashed as UTF-8: object keys sorted, arrays preserved in order, non-finite numbers serialised as `null`. `{a:1,b:2}` and `{b:2,a:1}` hash identically.

Hashes are correlation tokens, not lookup keys. Two records with the same `inputs_hash` had the same input; the plaintext is not recoverable from the log.

## What is intentionally not logged

The action record carries hashes only. The following are deliberately excluded from CloudWatch:

- Slack message bodies (incoming and outgoing). Slack channel emits `tool=message_send` with `outputs_hash` over the posted text; `tool=message_handle` hashes the streamed agent result. The text itself never reaches CloudWatch.
- Prompt plaintext for scheduled tasks and ad-hoc dispatches. `tool=container_run` hashes the prompt into `inputs_hash`.
- `.env` / env-file values. The fail-closed sentinel in `validateActionRecord` rejects any record whose string fields contain the live `ANTHROPIC_API_KEY` value.
- OAuth tokens, GitHub PATs, Slack bot/app tokens, Notion integration tokens, and any other secret pulled from AWS Secrets Manager.
- Credential-proxy request bodies and response bodies. Both are hashed; neither is logged. The upstream URL is logged as path-only — query string is stripped via `redactUrlPath` in `src/credential-proxy.ts`.
- Notion page content fetched through the reader RPC. `tool=reader_rpc` hashes the laundered output; the source content is held in memory only for the duration of the call.

If a future call site needs to record additional context, it MUST be a hash of the value, not the value itself. The closed-schema validator will reject any new top-level field.

## Where plaintext lives instead

Per-session conversation state is on local disk on the EC2 host, under the install root `/opt/nanoclaw`:

- `/opt/nanoclaw/data/sessions/<group folder>/.claude/` — Claude Code session jsonl, conversation history, file reads. One subtree per group; not shared across groups.
- `/opt/nanoclaw/data/sessions/<group folder>/policy/` — read-only policy overlay (settings.json + hooks). Not session content; included for reference because it shares the path prefix.
- `/opt/nanoclaw/groups/<group folder>/` — group-scoped configuration (CLAUDE.md, mounted into the container). Not conversation content.
- `/opt/nanoclaw/data/ipc/<group folder>/current_tasks.json` — IPC task queue snapshot.

These paths are not shipped to CloudWatch. Operator access requires either SSM session manager into the EC2 host or the planned vault export (#112).

## Currently-emitted (trigger, tool) catalogue

Snapshot of action emissions on `sagri-tokyo/nanoclaw` as of this document. The catalogue is best-effort; the ground truth is `git grep "logger.action" src/`.

| Trigger / Tool | Source | `session_id` | Notes |
| --- | --- | --- | --- |
| `slack` / `message_handle` | `src/index.ts` | Claude session id, falling back to the group folder | One per inbound Slack message after the agent run completes. `outputs_hash` aggregates streamed agent results. |
| `slack` / `message_send` | `src/channels/slack.ts` | Slack channel JID | One per outbound Slack post attempt: the initial-send success path (`outcome=ok`) and the failed-send-then-queued path (`outcome=error`) both emit. The later background queue-flush retry does not emit a separate record. |
| `scheduled` / `container_run` | `src/task-scheduler.ts` | Scheduled task id | One per `runTask` invocation. Covers early exits (invalid folder, group not found — `outcome=rejected`) and the post-agent path (`outcome=ok`/`error`). |
| `sub_request` / `anthropic_api` | `src/credential-proxy.ts` | Per-request UUID | One per proxied upstream call. Success, upstream HTTP error (`error_class=HttpStatus<n>`), and response stream error all emit. `trigger_source` is the redacted request path. |
| `sub_request` / `reader_rpc` | `src/reader-rpc.ts` | Chat JID, falling back to the reader source name | One per `read_untrusted` call. |
| `ipc` / `ipc_schedule_task` | `src/ipc.ts` | Source group or task id depending on branch | Authorised + unauthorised branches both emit (`outcome=ok` or `outcome=rejected`). |
| `ipc` / `ipc_pause_task` | `src/ipc.ts` | As above | As above. |
| `ipc` / `ipc_resume_task` | `src/ipc.ts` | As above | As above. |
| `ipc` / `ipc_cancel_task` | `src/ipc.ts` | As above | As above. |
| `ipc` / `ipc_update_task` | `src/ipc.ts` | As above | As above. |

Adding a new emission site means adding a new row here.

## Example CloudWatch Logs Insights queries

Run against log group `/sagri-ai/openclaw-prod`. The `ispresent` guards are deliberate — non-action lines (free-form `logger.info` diagnostics) lack these fields and would otherwise pollute the count.

### Actions per minute, by tool

```
fields @timestamp, tool
| filter ispresent(tool) and ispresent(trigger) and ispresent(outcome)
| stats count() as actions by bin(1m), tool
| sort @timestamp desc
```

### Error rate by trigger

```
fields @timestamp, trigger, outcome
| filter ispresent(trigger) and ispresent(outcome)
| stats count() as total,
        sum(outcome = "error") as errors,
        sum(outcome = "rejected") as rejected
        by trigger
| display trigger, total, errors, rejected, errors / total as error_rate
```

### Duration p95, p99 by tool

```
fields tool, duration_ms
| filter ispresent(tool) and ispresent(duration_ms)
| stats count() as n,
        pct(duration_ms, 50) as p50,
        pct(duration_ms, 95) as p95,
        pct(duration_ms, 99) as p99
        by tool
| sort p95 desc
```

### Closing-condition coverage check

Used to verify a freshly-redeployed instance is emitting on all primary surfaces. Closes #152 when the result includes non-zero counts for `(slack, message_handle)`, `(scheduled, container_run)`, and `(sub_request, anthropic_api)` within the first hour.

```
fields @timestamp, session_id, trigger, tool, outcome
| filter ispresent(session_id) and ispresent(trigger) and ispresent(tool) and ispresent(outcome)
| stats count() by trigger, tool
```
