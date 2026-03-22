---
name: add-restart-ipc
description: Add restart_nanoclaw IPC tool. Lets the main-group agent restart the NanoClaw host process via IPC. Auth-gated to main group only.
---

# Add Restart IPC

Adds a `restart_nanoclaw` MCP tool that lets the main-group agent trigger a graceful NanoClaw restart via IPC. The host process exits and launchd/systemd auto-restarts it.

## Pre-flight

Check if already applied:
```bash
grep -q 'restart_nanoclaw' container/agent-runner/src/ipc-mcp-stdio.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

```bash
git fetch origin skill/restart-ipc
git merge origin/skill/restart-ipc
```

## Phase 2: Build and verify

```bash
npm run build
./container/build.sh
```

## What This Adds

- **Container-side**: `restart_nanoclaw` MCP tool (main group only)
- **Host-side**: IPC handler in `ipc.ts` — graceful exit after 1.5s delay, auto-restarted by service manager
