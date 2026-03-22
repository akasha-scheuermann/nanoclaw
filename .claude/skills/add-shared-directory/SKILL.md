---
name: add-shared-directory
description: Auto-mount a shared read-write directory into all containers for inter-agent communication (queues, flags, shared state).
---

# Add Shared Directory

Automatically mounts a `shared/` directory from the NanoClaw project root into every container at `/workspace/extra/shared/`. Enables inter-agent communication via shared files.

## Pre-flight

Check if already applied:
```bash
grep -q 'shared' src/container-runner.ts | grep -q 'sharedDir' && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

```bash
git fetch origin skill/shared-directory
git merge origin/skill/shared-directory
```

## Phase 2: Build and verify

```bash
npm run build
```

No container rebuild needed — this only changes the host-side container runner.

## What This Adds

- **Auto-mount**: `shared/` directory mounted at `/workspace/extra/shared/` for all groups
- **Directory creation**: `shared/` and `shared/queues/` created automatically if missing
- Use `shared/queues/` for structured data exchange (JSON arrays) between agents
