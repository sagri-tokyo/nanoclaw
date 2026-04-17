# Diagnostics

Gather the anonymous setup-completion payload in one call:

```bash
pnpm exec tsx setup/index.ts --step diagnostics -- --channels <csv> [--migrated] [--failed-step <name>] [--error-count <n>]
```

`--channels` is the comma-separated list the user picked in step 5 (e.g. `telegram,whatsapp`). Add `--migrated` if `/migrate-from-openclaw` ran during this session — check `migration-state.md` in the project root after compaction. Add `--failed-step` + `--error-count` only if some step failed but setup continued.

The step writes `/tmp/nanoclaw-diagnostics.json`. Show it to the user via `AskUserQuestion`: **Yes** / **No** / **Never ask again**.

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/nanoclaw-diagnostics.json && rm /tmp/nanoclaw-diagnostics.json
```

**No**: `rm /tmp/nanoclaw-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/setup/diagnostics.md` with `# Diagnostics — opted out`
2. Replace contents of `.claude/skills/update-nanoclaw/diagnostics.md` with `# Diagnostics — opted out`
3. Remove the `## 8. Diagnostics` section from `.claude/skills/setup/SKILL.md` and the `## Diagnostics` section from `.claude/skills/update-nanoclaw/SKILL.md`
4. `rm /tmp/nanoclaw-diagnostics.json`
