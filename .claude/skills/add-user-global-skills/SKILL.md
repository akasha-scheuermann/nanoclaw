---
name: add-user-global-skills
description: Three-tier container skills — upstream (container/skills/) → user global (groups/global/skills/) → per-group (groups/{folder}/skills/). User global layer is gitignored.
---

# Add User Global Skills

Adds a middle tier for container skills: `groups/global/skills/`. These are available to all agents but gitignored (not tracked in the repo). Useful for domain-specific skills like task-manager or morning-routine that shouldn't be in the upstream codebase.

## Pre-flight

Check if already applied:
```bash
grep -q 'userGlobalSkillsSrc' src/container-runner.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Dependencies

Requires `skill/per-group-skills` for the per-group layer (third tier).

## Phase 1: Apply code changes

```bash
git fetch origin skill/user-global-skills
git merge origin/skill/user-global-skills
```

## Phase 2: Build and verify

```bash
npm run build
```

## Phase 3: Add user global skills

Create skill directories under `groups/global/skills/`:
```
groups/global/skills/task-manager/SKILL.md
groups/global/skills/morning-routine/SKILL.md
```

These will be available to all agents as slash commands.

## What This Adds

- Three-tier skill loading: upstream → user global → per-group
- `groups/global/skills/` directory (gitignored) for user-specific skills shared across all agents
- Each tier overrides the previous (per-group > user global > upstream)
- `.gitignore` entry for `groups/global/skills/`
