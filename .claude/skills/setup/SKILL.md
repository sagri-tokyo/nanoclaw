---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Welcome the user in ~3–4 warm sentences:

1. **What NanoClaw is** — a personal Claude assistant across your messaging apps (WhatsApp, Slack, Telegram, Discord, iMessage, email, and more). Per-conversation agent containers come up on demand; memory, conversation history, and files persist to disk, so next time a message arrives the container comes back up where it left off. Credentials live in a local OneCLI vault the agent never sees.
2. **What setup covers** — install deps, build the agent sandbox, wire your first messaging app, test a message.
3. You'll move slow work (bootstrap, container build, post-channel rebuild) to the background as you go, so they're not watching commands scroll by.

Not a wall of text.

Then explain that setup runs many shell commands, and recommend pre-approving the standard ones. Use `AskUserQuestion`:

1. **Pre-approve (recommended)** — "Pre-approve standard setup commands so you don't have to confirm each one. You can review the list first if you'd like."
2. **No thanks** — "I'll approve each command individually as it comes up."
3. **Show me the list first** — "Show me exactly which commands will be pre-approved before I decide."

If option 1:

```bash
./setup/scripts/preapprove.sh
```

- `STATUS: success` → continue.
- `STATUS: needs_manual` → python3 isn't available; tell the user you'll fall back to per-command approval and continue.

If option 3: read `.claude/skills/setup/setup-permissions.json`, display it, then re-ask with just options 1 and 2.

Declined → continue; they'll approve each command individually.

---

**Internal guidance (do not show to user):**

- Run steps automatically. Only pause when user action is required (channel auth, tokens, a sudo password, fork in the road).
- Setup uses `bash setup.sh` for bootstrap, then `pnpm exec tsx setup/index.ts --step <name>` for other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.
- **Fix things yourself.** Don't punt to the user unless they genuinely must act.
- **Long-running tasks** (bootstrap, container build) — move them to the background where possible and continue with the next non-dependent step. Check results before any step that depends on them.
- **AskUserQuestion** for multi-choice only. Free-text (tokens, phone numbers, paths) — ask plainly, wait.
- **Timeouts:** 5m for install/build.
- **Waiting on user:** give clear instructions, say "Let me know when done or if you need help", stop. Don't continue.

## 1. Bootstrap (Node.js + dependencies)

> **Tell the user:** "Installing Node and host dependencies — the orchestrator that routes messages to the agent containers."

Run `bash setup.sh`. Parse the status block:

- `STATUS: success` → record `PLATFORM` (and `IS_WSL` for later), proceed.
- `NODE_OK: false` → Node missing or too old. `AskUserQuestion` for install method:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`.
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm.
  - After installing, re-run `bash setup.sh`.
- `HAS_BUILD_TOOLS: false` + `NATIVE_OK: false` → confirm `xcode-select --install` (macOS) or `sudo apt install build-essential` (Linux). Then retry.
- `NATIVE_OK: false` with build tools present → `rm -rf node_modules`, re-run once. Still failing → surface log tail.
- `DEPS_OK: false` → `rm -rf node_modules`, re-run once. Still failing → surface log tail.

## 2. Preflight (upstream + environment + timezone)

`pnpm exec tsx setup/index.ts --step preflight` — one status block, three checks.

- `UPSTREAM: mismatch` → someone retargeted `upstream`; surface before touching.
- `HAS_AUTH=true` → WhatsApp already configured; note for step 5.
- `HAS_REGISTERED_GROUPS=true` → existing config; offer skip or reconfigure.
- Record `DOCKER` for step 3.
- `NEEDS_TZ_INPUT: true` → autodetect failed (e.g. POSIX-style `IST-2`). `AskUserQuestion` with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) plus Other. Re-run with `-- --tz <answer>`.
- `RESOLVED_TZ` is `UTC`/`Etc/UTC` → confirm: "Your system timezone is UTC — correct, or are you on a remote server?" If wrong, ask for the actual TZ and re-run with `--tz`.

### OpenClaw migration detection

If `OPENCLAW_PATH` is not `none`, `AskUserQuestion`:

1. **Migrate now** — "Import identity, credentials, and settings from OpenClaw before continuing."
2. **Fresh start** — "Skip migration."
3. **Migrate later** — "Continue now; run `/migrate-from-openclaw` any time."

If "Migrate now": invoke `/migrate-from-openclaw`, then return to step 3.

## 3. Container runtime (Docker)

> **Tell the user:** "The sandbox your agent runs in. One container per active conversation — isolated filesystem and tools. They spin up when a message arrives and spin back down when idle; memory and files persist on disk, so conversations pick up where they left off."

### 3a. Install Docker

- `DOCKER=running` → continue.
- `DOCKER=installed_not_running` → `./setup/scripts/ensure-docker-running.sh`. If `STATUS: timeout`, surface log tail.
- `DOCKER=not_found` → `AskUserQuestion`: "Docker is required — install it?" If yes:
  - macOS: `brew install --cask docker` → `open -a Docker` and wait. No brew → https://docker.com/products/docker-desktop.
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. User may need to log out/in for group membership.

### 3b. CJK fonts

Agent containers skip CJK fonts by default (~200MB saved). Without them, Chromium renders tofu for Chinese/Japanese/Korean.

- User writing to you in CJK → enable without asking; mention briefly.
- CJK timezone from step 2 (`Asia/Tokyo`, `Asia/Shanghai`, `Asia/Hong_Kong`, `Asia/Taipei`, `Asia/Seoul`) → ask: "Enable CJK fonts? Adds ~200MB, lets the agent render CJK in screenshots and PDFs."
- Otherwise → skip.

Enable: `./setup/scripts/upsert-env.sh INSTALL_CJK_FONTS true` (next build picks it up).

### 3c. Build and test

Docker is up and deps are installed. This build typically takes 1–5 min — a good candidate to move to the background so OneCLI setup (step 4) can proceed in parallel.

```bash
pnpm exec tsx setup/index.ts --step container -- --runtime docker
```

Check the result before step 5. Parse the status block:

- `BUILD_OK: true` + `TEST_OK: true` → proceed.
- `BUILD_OK: false` with stale-cache signals in `logs/setup.log` (e.g. "no such file", reused stale layer) → `docker builder prune -f`, retry once.
- `BUILD_OK: false` otherwise → surface 10–20 line log tail, ask user.
- `TEST_OK: false` but `BUILD_OK: true` → sleep 10s, retry once (daemon warming up).
- Docker daemon unreachable → `./setup/scripts/ensure-docker-running.sh`; still unreachable → ask user.

## 4. Credential system

> **Tell the user:** "Credential isolation. Your Anthropic token lives in a local vault (OneCLI). When the agent in a container calls the Anthropic API, OneCLI injects the credential at request time — the agent process never sees the key directly."

### 4a. Install OneCLI

```bash
./setup/scripts/install-onecli.sh
```

Record `ONECLI_URL` (used below in the dashboard path).

- `STATUS: success` + `URL_CONFIGURED: true` → continue.
- `STATUS: success` + `URL_CONFIGURED: false` → installer didn't print a URL. Find it in `logs/setup.log` (usually `http://localhost:<port>`), run `onecli config set api-host <URL>` and `./setup/scripts/upsert-env.sh ONECLI_URL <URL>`.
- `STATUS: failed` → surface `STAGE` + log tail.

Check for existing secret:

```bash
onecli secrets list
```

Anthropic secret present → confirm keep or reconfigure. Keep → skip to step 5.

`AskUserQuestion`: Use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal."
2. **Anthropic API key** — "Pay-per-use API key from console.anthropic.com."

#### Subscription path

> Run `claude setup-token` in another terminal. It outputs a token — copy it but don't paste it here.

Wait for the user to confirm they have the token. Do not proceed until they respond.

Once confirmed, `AskUserQuestion`:

1. **Dashboard** — "Best with a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one. Then `AskUserQuestion`:

1. **Dashboard** — "Open ${ONECLI_URL} and add the secret in the UI."
2. **CLI** — "Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If their response happens to contain a token or key** (starts with `sk-ant-`): handle gracefully — run `onecli secrets create` with that value on their behalf.

Verify with `onecli secrets list`. Missing → ask again.

## 5. Set up the first messaging app

> **Tell the user:** "Pick your first messaging app — Discord, Slack, Telegram, WhatsApp, email, GitHub, Linear, iMessage, and more, all wired the same way. Add more later with `/customize`."

Show the full list in plain text (not `AskUserQuestion` — it caps at 4 options). Recommended = agent gets its own identity (name + avatar).

1. Discord *(recommended — agent gets own identity)*
2. Slack *(recommended — agent gets own identity)*
3. Telegram *(recommended — agent gets own identity)*
4. Microsoft Teams *(recommended — agent gets own identity)*
5. Webex *(recommended — agent gets own identity)*
6. WhatsApp
7. WhatsApp Cloud API
8. iMessage
9. GitHub
10. Linear
11. Google Chat
12. Resend (email)
13. Matrix

**Delegate to the selected channel's skill.** Each handles its own package installation, authentication, configuration, and build:

- **Discord:** `/add-discord`
- **Slack:** `/add-slack`
- **Telegram:** `/add-telegram`
- **GitHub:** `/add-github`
- **Linear:** `/add-linear`
- **Microsoft Teams:** `/add-teams`
- **Google Chat:** `/add-gchat`
- **WhatsApp Cloud API:** `/add-whatsapp-cloud`
- **WhatsApp Baileys:** `/add-whatsapp`
- **Resend:** `/add-resend`
- **Matrix:** `/add-matrix`
- **Webex:** `/add-webex`
- **iMessage:** `/add-imessage`

The channel skill's final step is `pnpm run build`, so `dist/` is ready by the time step 6 starts. If that step fails, `./setup/scripts/rebuild.sh` retries install + build.

## 6. Start service

`pnpm exec tsx setup/index.ts --step service` — the step stops any previously loaded unit before loading the new one. Parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd. Either enable systemd (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` + restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** user was added to the docker group after session started — systemd can't reach the socket. Ask them to run:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (reapplies after every Docker restart):

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```

Replace `USERNAME` with `whoami`. Run separately. After setfacl, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log`.
- macOS: `launchctl list | grep nanoclaw`; PID=`-` → read `logs/nanoclaw.error.log`.
- Linux: `systemctl --user status nanoclaw`.
- Re-run after fixing.

## 6a. Wire conversations to agents

> **Tell the user:**
>
> "Wiring decides which *agent* answers which conversation:
> - Each group/chat/DM you talk to is a **conversation** in NanoClaw.
> - Conversations route to an **agent** (Claude persona — name, memory, files, tools, permissions).
> - Each active conversation spawns a **session** (its own container).
>
> Flexibility: multiple WhatsApp groups can share one agent (separate sessions, same memory/files) or get different agents. Same for mixing apps — WhatsApp + Telegram on one agent, or split.
>
> **Privacy boundary is the agent, not the session.** Sessions share the agent's memory and files. If you don't want info crossing between two conversations, give them separate agents."

The service is now running, so polling-based adapters (Telegram) can observe inbound messages — required for pairing.

Invoke `/manage-channels`. It:

1. Creates the agent group(s) and names the assistant.
2. Resolves each channel's platform-specific ID (Telegram via pairing code; others via platform ID lookup).
3. Decides isolation level — share an agent, a session, or fully separate.

`/manage-channels` reads each channel's `## Channel Info` section from its SKILL.md for platform-specific guidance (terminology, ID lookup, recommended isolation).

**Required.** Without it, channels are installed but messages are silently dropped (router has no agent group to route to).

## 6b. Dashboard & web applications

> **Tell the user:** "What your agent can do out of the box: talk on the app you just wired, browse the web (built-in Chromium), self-customize per conversation ('remember X for this chat'), install its own packages and MCP servers (with approval). Add more later with `/customize` — more messaging apps, `/add-resend` (email), `/add-karpathy-llm-wiki` (persistent knowledge base). Dashboard + Vercel is up next: dashboard for monitoring, Vercel lets the agent publish websites."

`AskUserQuestion`: Create a dashboard and build web apps?

1. **Yes (recommended)** — "Monitor your agents and publish custom websites. Deploys to Vercel."
2. **Not now** — "Add later with `/add-vercel`."

Yes → invoke `/add-vercel`.

## 7. Verify

`pnpm exec tsx setup/index.ts --step verify` — parse the status block.

**If STATUS=failed, fix each:**

- `SERVICE=stopped` → `pnpm run build && ./setup/scripts/restart-service.sh restart`
- `SERVICE=not_found` → re-run step 6.
- `CREDENTIALS=missing` → re-run step 4 (check `onecli secrets list`).
- `CHANNEL_AUTH` shows `not_found` for any channel → re-invoke that channel's skill.
- `REGISTERED_GROUPS=0` → re-invoke `/manage-channels` from step 6a.

Tell the user to test: send a message in their registered chat. Tail: `tail -f logs/nanoclaw.log`.

## Troubleshooting

**Service not starting:** check `logs/nanoclaw.error.log`. Common causes: wrong Node path (re-run step 6), credential system not running (check `curl ${ONECLI_URL}/api/health`), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** ensure Docker is running with `./setup/scripts/ensure-docker-running.sh`. Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** check trigger pattern. Main channel doesn't need prefix. Run `pnpm exec tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** verify credentials in `.env`. Channels auto-enable when their credentials are present. WhatsApp → `store/auth/creds.json` exists. Token-based channels → values in `.env`. Restart the service after any `.env` change.

**Unload service:** `./setup/scripts/restart-service.sh stop`

## 8. Diagnostics

Read `.claude/skills/setup/diagnostics.md` and follow every step before completing setup.

## 9. Fork setup

Only run this after the user has confirmed 2-way messaging works.

Ask the user in plain text:

> We recommend forking NanoClaw so you can push your customizations and pull updates easily. Would you like to set up a fork now?

If yes: instruct the user to fork `qwibitai/nanoclaw` on GitHub (browser), ask for their GitHub username, then:

```bash
git remote rename origin upstream 2>/dev/null || true
git remote add origin https://github.com/<their-username>/nanoclaw.git 2>/dev/null || git remote set-url origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```

If no: skip — upstream is already configured from step 2.
