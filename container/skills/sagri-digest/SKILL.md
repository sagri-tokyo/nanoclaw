---
name: sagri-digest
description: Generate a daily engineering activity digest across all sagri-tokyo GitHub repositories. Use when asked for a daily summary, digest, or activity report covering PRs, issues, and CI status. Output is formatted for Slack.
---

## Purpose

Produce a concise engineering digest for the sagri-tokyo GitHub organisation covering the last 24 hours. The output is formatted for Slack.

## Repositories to cover

- `sagri-tokyo/mrv`
- `sagri-tokyo/farmland-utilization`
- `sagri-tokyo/ml-rqs`
- `sagri-tokyo/dohyo`
- `sagri-tokyo/soil_satellite_prediction_RnD`
- `sagri-tokyo/ml-commons`

## Output format

Post a single Slack message with the following structure:

```
*Engineering Digest — <date>*  (last 24 hours)

*PRs merged*
• <repo>: <PR title> (#<number>) — @<author>
…  (or "None" if empty)

*Issues opened*
• <repo>: <title> (#<number>)
…  (or "None" if empty)

*Issues closed*
• <repo>: <title> (#<number>)
…  (or "None" if empty)

*CI failures*
• <repo>: <workflow> failed on `<branch>` — <link>
…  (or "None" if empty)
```

Keep each line short. Truncate titles beyond 80 characters with `…`.

## Step-by-step instructions

### 1. Compute the time window

Calculate the ISO 8601 timestamp for 24 hours ago:

```bash
SINCE=$(date -u -d '24 hours ago' '+%Y-%m-%dT%H:%M:%SZ')
[ -n "$SINCE" ] || { echo "ERROR: could not compute time window" >&2; exit 1; }
TODAY=$(date -u '+%Y-%m-%d')
```

### 2. Set up authentication

```bash
AUTH_HEADER="Authorization: Bearer ${GITHUB_TOKEN}"
ACCEPT_HEADER="Accept: application/vnd.github+json"
API="https://api.github.com"
```

### 3. Fetch data for each repository

For each repo in the list above, run the following queries. Collect results per section.

#### PRs merged in the last 24 hours

```bash
curl -s -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" \
  "$API/repos/$OWNER/$REPO/pulls?state=closed&sort=updated&direction=desc&per_page=100" \
  | jq --arg since "$SINCE" --arg repo "$REPO" '
      [.[] | select(
        .merged_at != null and
        .merged_at >= $since
      ) | {
        repo: $repo,
        number: .number,
        title: .title,
        author: .user.login
      }]'
```

#### Issues opened in the last 24 hours

```bash
curl -s -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" \
  "$API/repos/$OWNER/$REPO/issues?state=open&sort=created&direction=desc&per_page=100" \
  | jq --arg since "$SINCE" --arg repo "$REPO" '
      [.[] | select(
        (.pull_request | not) and
        .created_at >= $since
      ) | {
        repo: $repo,
        number: .number,
        title: .title
      }]'
```

#### Issues closed in the last 24 hours

```bash
curl -s -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" \
  "$API/repos/$OWNER/$REPO/issues?state=closed&sort=updated&direction=desc&per_page=100" \
  | jq --arg since "$SINCE" --arg repo "$REPO" '
      [.[] | select(
        (.pull_request | not) and
        .closed_at != null and
        .closed_at >= $since
      ) | {
        repo: $repo,
        number: .number,
        title: .title
      }]'
```

#### CI workflow run failures in the last 24 hours

```bash
curl -s -H "$AUTH_HEADER" -H "$ACCEPT_HEADER" \
  "$API/repos/$OWNER/$REPO/actions/runs?status=completed&conclusion=failure&per_page=20" \
  | jq --arg since "$SINCE" --arg repo "$REPO" '
      [.workflow_runs[] | select(
        .updated_at >= $since
      ) | {
        repo: $repo,
        workflow: .name,
        branch: .head_branch,
        url: .html_url
      }]'
```

### 4. Aggregate and deduplicate

Combine results across all repositories per section. Deduplicate PRs and issues by `(repo, number)`. Deduplicate CI failures by `(repo, workflow, branch)`, keeping only the most recent run.

### 5. Format the Slack message

Assemble the sections in order. If a section has no entries, emit `None`.

### 6. Post to Slack (if requested)

If the user asks you to post the digest, use the `SLACK_WEBHOOK_URL` environment variable:

```bash
curl -s -X POST "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg text "$DIGEST" '{"text": $text}')"
```

Otherwise, return the formatted text to the user.

## Error handling

- If any repo returns 403, abort and report an authentication failure.
- If a repo returns 404, include a visible warning in the digest header that the repo was skipped.
- Include bot authors (e.g. `dependabot`) in the digest.
- Never fabricate data. If a fetch fails, mark that section as unavailable rather than omitting it silently.
