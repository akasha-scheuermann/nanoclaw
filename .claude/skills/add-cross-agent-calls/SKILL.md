---
name: add-cross-agent-calls
description: Add cross-agent IPC communication. Agents can call other agents and wait for responses. Includes concurrency guard (max 2 concurrent calls).
---

# Add Cross-Agent Calls

Enables agents to call other agents via IPC and wait for responses. Target agent runs in an isolated container with the provided prompt.

## Pre-flight

Check if already applied:
```bash
grep -q 'call_agent' container/agent-runner/src/ipc-mcp-stdio.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

Merge the skill branch:
```bash
git fetch origin skill/cross-agent-calls
git merge origin/skill/cross-agent-calls
```

If there are merge conflicts:
```bash
git checkout --theirs package-lock.json 2>/dev/null; git add package-lock.json 2>/dev/null
git merge --continue
```

## Phase 2: Build and verify

```bash
npm run build
./container/build.sh
```

## Phase 3: Test

Restart NanoClaw and test from the main group:
- Use `call_agent` tool with a target group folder and prompt
- The target agent will run in isolation and return its response

## What This Adds

- **Host-side**: `processAgentCallRequest()` in `ipc.ts` with MAX_CONCURRENT_AGENT_CALLS=2 concurrency guard
- **Container-side**: `call_agent` MCP tool in `ipc-mcp-stdio.ts` with file-based request/response polling
- **IPC directories**: `agent_requests/` and `agent_responses/` per group
- Agents write request files, host spawns target container, writes response, source polls until complete
