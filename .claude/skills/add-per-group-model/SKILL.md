---
name: add-per-group-model
description: Per-group model override. Set different Claude models per agent group via the model column in registered_groups.
---

# Add Per-Group Model Override

Adds a `model` column to `registered_groups` and passes it as `CLAUDE_CODE_MODEL` env var to containers. Allows different agents to use different Claude models (e.g., Haiku for simple agents, Opus for complex ones).

## Pre-flight

Check if already applied:
```bash
grep -q 'CLAUDE_CODE_MODEL' src/container-runner.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

```bash
git fetch origin skill/per-group-model
git merge origin/skill/per-group-model
```

## Phase 2: Build and verify

```bash
npm run build
```

## Phase 3: Configure models

Set a model for a group via sqlite:
```sql
UPDATE registered_groups SET model = 'claude-haiku-4-5-20251001' WHERE folder = 'whatsapp_shopping';
```

Or via the `register_group` IPC tool (accepts `model` parameter).

Leave `model` NULL to use the default (inherited from env or SDK default).

## What This Adds

- `model` column on `registered_groups` (nullable, auto-migrated)
- Container-runner reads model and passes `CLAUDE_CODE_MODEL` env var
- `register_group` IPC accepts optional `model` parameter
- NULL = use default model
