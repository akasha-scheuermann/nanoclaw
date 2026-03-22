---
name: add-fastmail
description: Add Fastmail email integration via JMAP API. Runs as an in-container MCP server — no host-side bridge needed.
---

# Add Fastmail Integration

Adds Fastmail email tools (list, search, read, send, move) to all agent containers via JMAP API.

## Pre-flight

Check if already applied:
```bash
grep -q 'fastmail-mcp' container/agent-runner/src/index.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

Merge the skill branch:
```bash
git fetch origin skill/fastmail
git merge origin/skill/fastmail
```

If there are merge conflicts:
```bash
git checkout --theirs package-lock.json 2>/dev/null; git add package-lock.json 2>/dev/null
git merge --continue
```

## Phase 2: Configure credentials

1. Ask the user for their Fastmail API token:
   - Go to https://www.fastmail.com/settings/security/tokens
   - Create a new API token with JMAP scope
   - Copy the token (starts with `fmu1-`)

2. Add to `.env`:
```
FASTMAIL_API_TOKEN=fmu1-...
```

The account ID is auto-discovered from the JMAP session. Only set `FASTMAIL_ACCOUNT_ID` if you have multiple accounts.

## Phase 3: Build and verify

```bash
npm run build
./container/build.sh
```

## Phase 4: Test

Restart NanoClaw and test from any agent:
- "Check my email" — should list recent inbox messages
- "Search emails from john" — should search by sender

## What This Adds

- **In-container MCP server** (`fastmail-mcp.ts`) with JMAP tools
- **Tools**: `list_mailboxes`, `list_emails`, `get_email`, `search_emails`, `move_email`, `mark_as_read`, `send_email`, `list_attachments`
- **Env var forwarding** in container-runner for `FASTMAIL_API_TOKEN` and `FASTMAIL_ACCOUNT_ID`
- **Auto-enabled**: Server starts only when `FASTMAIL_API_TOKEN` is set in `.env`
