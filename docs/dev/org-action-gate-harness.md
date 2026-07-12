# Org-action approval gate — local exercise harness

Dev tooling for exercising the D2.4 host-side approval gate (`src/org-action-*.ts`)
without deploying. Three levels, cheapest first. All are opt-in; nothing here
runs in production (the live channel and write stub are gated behind env flags).

Requires Node 22 (the `better-sqlite3` native dep). Build first: `npm run build`.

## Level 0 — gate only (`harness-org-action.mts`)

Drives `driveOrgActionRequest` / `handleApprovalReply` / `reDriveApprovedActions`
directly with logging dependencies and an in-memory DB. No IPC, no LLM. Covers
safe-execute, gated hold, approve → exactly-once, replay-after-consume,
adversarial `stakes_hint` (red-line refused regardless), bot/self and
non-allowlisted approver rejection, and re-classify-at-approve on a tampered row.

```
npx tsx harness-org-action.mts
```

## Level 1 — real IPC entry (`harness-org-action-ipc.mts`)

Drives the real `processTaskIpc` (`org_action` verb) and the real inbound
dispatch (`handleInboundMessage`) — the two seams `index.ts` wires in
production — with Slack send and the write clients stubbed to loggers. Adds, over
level 0: IPC field/enum validation, `canonical_args` object check, `chatJid`
resolution, the action-record audit sink, and inbound check ordering.

```
npx tsx harness-org-action-ipc.mts
```

## Level 2 — full stack, real LLM (`src/channels/harness.ts`)

Runs the actual host + one real container agent (real Claude via the credential
proxy), exercising reader/actor laundering, the org-actions dispatch, the
`mcp__nanoclaw__org_action` MCP tool, the host IPC drain, and the gate. Only the
external writes (Notion/GitHub/Slack) and the Slack channel itself are stubbed;
the Claude API call is real.

The `harness` channel self-registers only when `NANOCLAW_HARNESS=1`. On connect
it injects a scripted operator message, records every outbound, and — when it
sees the host's `approve <token>` prompt — injects an approval reply from the
allowlisted approver.

### Env flags

| var | purpose |
|---|---|
| `NANOCLAW_HARNESS=1` | register the fake channel (required) |
| `NANOCLAW_STUB_ORG_WRITES=1` | replace the org-action write client with a logger |
| `NANOCLAW_HARNESS_TRIGGER` | the operator message to inject |
| `NANOCLAW_HARNESS_APPROVER` | the Slack user id that approves (default `U_HARNESS_APPROVER`) |
| `NANOCLAW_HARNESS_AUTOCONFIRM=1` | re-send the request if the actor asks to confirm |

### One-time setup (not committed — local runtime state)

```bash
# 1. approver allowlist (fail-closed; outside the repo)
mkdir -p ~/.config/nanoclaw
echo '{"approvers":["U_HARNESS_APPROVER"]}' > ~/.config/nanoclaw/approver-allowlist.json

# 2. Claude credential for the proxy (CREDENTIALS_DIRECTORY, not .env)
mkdir -p /tmp/nc-creds
printf '%s' "$CLAUDE_OAUTH_TOKEN" > /tmp/nc-creds/CLAUDE_CODE_OAUTH_TOKEN

# 3. the org-actions skill + dispatch prompt come from the sagri-ai overlay repo;
#    copy skills/org-actions/SKILL.md into container/skills/org-actions/, and put
#    prompts/org-actions-dispatch.md into groups/<folder>/CLAUDE.md so the actor
#    dispatches in one shot instead of asking for chat confirmation.

# 4. env-provided target id for a gated notion.write_property (sanctioned source,
#    so the actor accepts it without notion-reader resolution)
mkdir -p data/env && echo NANOCLAW_TARGET_PAGE_ID > data/env/forward-list

# 5. seed one registered (main) group
node harness-seed-group.mjs
```

### Run

```bash
CREDENTIALS_DIRECTORY=/tmp/nc-creds \
NANOCLAW_HARNESS=1 NANOCLAW_STUB_ORG_WRITES=1 \
NANOCLAW_TARGET_PAGE_ID=<32-hex> \
NANOCLAW_HARNESS_TRIGGER="set-property: set the Status property of the Tasks page to Approved." \
node dist/index.js
```

Watch for: `org-action held pending approval` → the harness injecting
`approve <token>` → `org-action executed after approval (exactly-once)` →
the stub `logger.warn` line `org-action STUB: external write suppressed
(NANOCLAW_STUB_ORG_WRITES=1)` carrying the `request` record.

The target id is sourced from the env (`NANOCLAW_TARGET_PAGE_ID`), not the
laundered message — the reader/actor pipeline refuses to source a write target
from untrusted prose, which is by design. A shape-valid id is enough; the gate
classifies on shape and the write is stubbed. For a real write, supply a real
Notion token + the `notion-reader` skill and un-stub.
