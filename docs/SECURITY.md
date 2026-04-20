# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (store, group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart. The `store/` directory is mounted read-write so the main agent can access the SQLite database directly.

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 3a. Memory-Gate Integrity

The memory-gate is enforced by a Claude Code `PreToolUse` hook declared in `settings.json`. The gate is security-critical: without it, non-admin sources can poison long-term memory (see `memory-gate.ts` for the provenance schema).

**Threat.** The group's `.claude/` directory is a writable bind mount so Claude can persist session data, skills, and command history. If `settings.json` and `hooks/` lived inside that same writable mount, a compromised agent could:

1. `Write` to `/home/node/.claude/settings.json` and remove `hooks.PreToolUse` (or point the hook at `/bin/true`).
2. `Write` a benign no-op over `/home/node/.claude/hooks/memory-gate-hook.js`.
3. Persist poisoned memory entries on subsequent `Write` calls — the gate is effectively off.

Claude Code `settings.json` is the wrong location for security-critical config when the subject of the config (Claude) has write access to the file.

**Mitigation.** Per-group config is split across two host directories:

- `data/sessions/{group}/.claude/` — writable. Mounted at `/home/node/.claude` (rw). Holds sessions, skills, projects, command history.
- `data/sessions/{group}/policy/` — host-only. Its `settings.json` and `hooks/` are overlaid **read-only** on top of the writable `.claude/` mount (in that order, so they take precedence):
  - `policy/settings.json` → `/home/node/.claude/settings.json` (ro)
  - `policy/hooks/`        → `/home/node/.claude/hooks` (ro)

`settings.json` is re-authored by the host on every container start, so any stale on-disk copy is overwritten and no code path reads a settings.json produced by the container.

**`SAGRI_MEMORY_DIR` sourcing.** The memory-gate hook reads the target directory from `process.env.SAGRI_MEMORY_DIR`. This value is injected by the host via `docker -e SAGRI_MEMORY_DIR=…`, never by the container's `settings.json.env`. This prevents a bypass where a compromised agent redirects the gate to an unmonitored path.

**Integration test.** `memory-gate.integration.test.ts` spawns a real container that simulates a compromised agent writing to `/home/node/.claude/settings.json` and `/home/node/.claude/hooks/memory-gate-hook.js`. Both writes return non-zero and the host-side files are byte-identical before and after, proving the overlay closes the bypass. Unrelated writes under `/home/node/.claude/` (e.g. session data) still succeed.

**Out of scope.** This mitigation does not defend against a compromised host process — the host is the trust anchor that authors `settings.json` and forwards `SAGRI_MEMORY_DIR`. Reader/actor split (issue #35) is the complementary defense against prompt-injected content reaching the actor in the first place.

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Isolation (OneCLI Agent Vault)

Real API credentials **never enter containers**. NanoClaw uses [OneCLI's Agent Vault](https://github.com/onecli/onecli) to proxy outbound requests and inject credentials at the gateway level.

**How it works:**
1. Credentials are registered once with `onecli secrets create`, stored and managed by OneCLI
2. When NanoClaw spawns a container, it calls `applyContainerConfig()` to route outbound HTTPS through the OneCLI gateway
3. The gateway matches requests by host and path, injects the real credential, and forwards
4. Agents cannot discover real credentials — not in environment, stdin, files, or `/proc`

**Per-agent policies:**
Each NanoClaw group gets its own OneCLI agent identity. This allows different credential policies per group (e.g. your sales agent vs. support agent). OneCLI supports rate limits, and time-bound access and approval flows are on the roadmap.

**NOT Mounted:**
- Channel auth sessions (`store/auth/`) — host only
- Mount allowlist — external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (ro) | None |
| Store (SQLite DB) | `/workspace/project/store` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming Messages (potentially malicious)                         │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • OneCLI Agent Vault (injects credentials, enforces policies)   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • API calls routed through OneCLI Agent Vault                   │
│  • No real credentials in environment or filesystem              │
└──────────────────────────────────────────────────────────────────┘
```
