---
name: add-fastmail
description: Add Fastmail email integration via the fastmail-mcp-server npm package. Runs as an in-container MCP server — no host-side bridge needed.
---

# Add Fastmail Integration

Adds Fastmail email tools to all agent containers using the community `fastmail-mcp-server` npm package (JMAP-based).

## Pre-flight

Check if already applied:
```bash
grep -q 'fastmail-mcp-server' container/agent-runner/package.json && echo "ALREADY APPLIED" || echo "NOT APPLIED"
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

3. (Optional) Block dangerous tools by adding to `.env`:
```
FASTMAIL_BLOCKED_TOOLS=send_email,mark_as_spam
```
   - Comma-separated list of tool names to hard-block at the SDK level
   - Blocked tools are completely unavailable to agents (not just discouraged)
   - Common tools to block: `send_email`, `reply_to_email`, `forward_email`, `mark_as_spam`, `move_email`
   - Leave unset to allow all tools

## Phase 3: Build and verify

`fastmail-mcp-server` is a TypeScript-first package that requires `bun` as its runtime. The Dockerfile installs bun automatically as part of this skill — no manual steps needed.

```bash
cd container/agent-runner && npm install && cd ../..
npm run build
./container/build.sh
```

## Phase 4: Test

Restart NanoClaw and test from any agent:
- "Check my email" — should list recent inbox messages
- "Search emails from john" — should search by sender

## What This Adds

- **`fastmail-mcp-server` npm package** as a container dependency
- **MCP server config** in `container/agent-runner/src/index.ts` — spawns the package as a child-process MCP server
- **Env var forwarding** for `FASTMAIL_API_TOKEN` and `FASTMAIL_BLOCKED_TOOLS`
- **Tool blocking** via `FASTMAIL_BLOCKED_TOOLS` env var — hard-blocks listed tools at SDK level using `disallowedTools`
- **Auto-enabled**: Server starts only when `FASTMAIL_API_TOKEN` is set in `.env`

### Tools provided by `fastmail-mcp-server`

Full read/write email access via JMAP:
- List mailboxes, list/search/read emails
- Send, reply, forward emails (with preview→confirm safety flow)
- Move emails, mark as read/spam
- Thread support, attachment text extraction
- Masked email management
