---
name: add-per-group-skills
description: Per-group skill overrides. Skills in groups/{folder}/skills/ are symlinked into the container, overriding global skills.
---

# Add Per-Group Skills

After global container skills are copied, this reads `groups/{folder}/skills/` and symlinks each skill directory into the container's `.claude/skills/` using container paths. Per-group skills override globals. Edits take effect on next container spawn without re-copying.

## Pre-flight

Check if already applied:
```bash
grep -q 'groupSkillsSrc' src/container-runner.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

```bash
git fetch origin skill/per-group-skills
git merge origin/skill/per-group-skills
```

## Phase 2: Build and verify

```bash
npm run build
```

## Phase 3: Add per-group skills

Create skill directories under any group:
```
groups/whatsapp_planning/skills/morning-routine/SKILL.md
groups/whatsapp_system/skills/desktop-sort/SKILL.md
```

These will be available as slash commands only in that group's agent.

## What This Adds

- Reads `groups/{folder}/skills/` on container spawn
- Symlinks each skill into `.claude/skills/` using `/workspace/group/skills/{name}` path
- Overrides global skills of the same name
- Changes to per-group skills take effect on next spawn (no re-copy needed)
