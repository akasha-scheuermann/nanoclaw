# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Database Schema

Single SQLite database at `store/messages.db` (better-sqlite3). Journal mode configurable via `SQLITE_JOURNAL_MODE` env var, defaults to DELETE for Docker bind-mount compatibility. Schema defined in `src/db.ts:createSchema()` with inline ALTER TABLE migrations for backward compatibility.

### Tables

| Table | PK | Purpose |
|-------|-----|---------|
| `chats` | `jid` | Chat/group metadata — name, last activity, channel type, group flag. Special row `__group_sync__` tracks last metadata sync time. |
| `messages` | `(id, chat_jid)` | Message history for registered groups only. FK to `chats.jid`. Indexed on `timestamp`. |
| `reactions` | `(message_id, message_chat_jid, reactor_jid)` | Emoji reactions on messages. Indexed on message, reactor, emoji, and timestamp. Empty emoji = delete reaction. |
| `registered_groups` | `jid` | Groups registered for agent processing. `folder` is UNIQUE. `container_config` is JSON. `requires_trigger` controls whether trigger word is needed. `model` for per-group model override. `is_main` flags the primary group. |
| `scheduled_tasks` | `id` | Cron/scheduled tasks per group. `schedule_type` + `schedule_value` define timing. `context_mode` is `'isolated'` or `'conversational'`. `status`: active/completed. |
| `task_run_logs` | `id` (autoincrement) | Execution log for scheduled tasks. FK to `scheduled_tasks.id`. Cascade-deleted when parent task is deleted. |
| `sessions` | `group_folder` | Maps group folders to Claude Agent SDK session IDs. |
| `router_state` | `key` | Key-value store for router state (`last_timestamp`, `last_agent_timestamp`). |

### Key Columns

**messages**: `is_from_me` (0/1), `is_bot_message` (0/1, backfilled from content prefix), `thread_message_id` (for thread replies).

**chats**: `channel` (whatsapp/discord/telegram/etc), `is_group` (0/1). Backfilled from JID patterns on migration (`@g.us` = whatsapp group, `@s.whatsapp.net` = whatsapp DM, `dc:` = discord, `tg:` = telegram).

### Known Gotcha

SQL `LIMIT ?` with parameterized placeholders doesn't work reliably in better-sqlite3 — use hardcoded `LIMIT N` values instead (see `feedback_db_limit_bug.md` in memory).

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
