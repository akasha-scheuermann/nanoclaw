# Initiative Loop — Container Skill

A work session where the agent selects and executes work autonomously rather than waiting for a message. Every agent with an initiative loop schedule follows this protocol each time the loop fires.

---

## Protocol

### 1. Check your queue and recent reactions

Call `mcp__nanoclaw__list_work_items` with `status_filter: ["queued", "in_progress", "blocked"]` to see current WIP and backlog.

Call `mcp__nanoclaw__get_reaction_summary` (default: last 30 days) to review how your recent messages landed. Note any 👎 reactions and the message snippets — use this to calibrate your approach this session. A pattern of negative reactions on a specific output type is a quality signal to address.

### 2. Respect WIP limits

If you already have item(s) `in_progress`, complete or defer them before starting new work. The host enforces this — attempting to move a new item to `in_progress` while at your limit will return an error.

### 3. Select work

Review your Focus Area goals and active projects. Choose the highest-leverage unblocked work you can complete this session. Prefer:
- Unblocked items already in your queue (`queued`)
- Work that directly advances an active project goal
- Maintenance work that is overdue

### 4. Register and start

Call `mcp__nanoclaw__create_work_item` with:
- `title` — what you're doing
- `reasoning` — why you chose this (for the activity log and Mission Control)
- `source` — `"initiative_loop"` or `"vault:path/to/project.md"`

Then call `mcp__nanoclaw__update_work_item` to set `status: "in_progress"`.

### 5. Do the work

Execute using your normal tools — read/write vault files, call agents, update reminders, run scripts, etc.

### 6. Close out

- Completed → `update_work_item` with `status: "done"` and a concise `outcome` describing what was produced
- Blocked → `update_work_item` with `status: "blocked"` and `blocked_reason`
- Out of time → `update_work_item` with `status: "deferred"`

### 7. Write activity log

Append a session entry to `/workspace/group/activity.log` (create if it doesn't exist). See format below.

### 8. Send summary

Use `mcp__nanoclaw__send_message` to send a brief summary to the group. Keep it tight — what you did, what the outcome was, anything blocked.

---

## Activity Log Format

Each session appends one entry to `/workspace/group/activity.log`:

```
--- [YYYY-MM-DD HH:MM ET] Initiative Session ---
Selected: <title of work item chosen>
Reasoning: <why this work was selected>
Actions:
  - <what was done>
  - <what was done>
Outcome: <what was produced | "Blocked: <reason>" | "Deferred: <reason>">
Work item: #<id> → <final status>
---
```

Keep entries to 5–10 lines. The log is machine-readable for Mission Control (Phase 15) and human-readable for Ryan's review.

---

## Self-Review Cycle

A deeper weekly self-review — reading all reactions from the past 30 days, identifying patterns, writing findings to a memory file — runs as a *separate* scheduled task. This is distinct from the quick reaction check in step 1. When configured for your agent, it will be documented in your CLAUDE.md.

---

## MCP Tools Reference

| Tool | Purpose |
|------|---------|
| `mcp__nanoclaw__list_work_items` | List queue items by status filter |
| `mcp__nanoclaw__create_work_item` | Add a new item to your queue |
| `mcp__nanoclaw__update_work_item` | Transition status, set outcome/blocked_reason |
| `mcp__nanoclaw__get_reaction_summary` | Reaction stats on your recent messages |
