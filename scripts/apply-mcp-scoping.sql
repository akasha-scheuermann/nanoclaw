-- MCP Tool Scoping: Per-group allowedMcpTools
-- Run: sqlite3 store/messages.db < scripts/apply-mcp-scoping.sql
--
-- Universal tools (via UNIVERSAL_MCP_ALLOWLIST env var) apply to ALL groups:
--   send_message, react_to_message, call_agent, create_work_item, update_work_item,
--   list_work_items, get_reaction_summary, calendar_*, list_reminders,
--   list_reminder_lists, list_today_reminders, schedule_task, list_tasks,
--   pause_task, resume_task, cancel_task, update_task
--
-- Per-group additions below:

-- System ops groups: register_group, restart_nanoclaw, snapshot_groups, rebuild_container
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.allowedMcpTools',
  json('["register_group","restart_nanoclaw","snapshot_groups","rebuild_container"]')
) WHERE folder IN ('whatsapp_system', 'whatsapp_main', 'imessage_ryan', 'whatsapp_system-dev', 'whatsapp_system-dev-frontend');

-- Tasks: only agent with Reminders write access
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.allowedMcpTools',
  json('["create_reminder","complete_reminder","update_reminder","delete_reminder"]')
) WHERE folder = 'whatsapp_tasks';

-- Inbox: only agent with Fastmail access
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.allowedMcpTools',
  json('["mcp__fastmail__*"]')
) WHERE folder = 'whatsapp_inbox';

-- Entertainment: only agent with Plex access
UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.allowedMcpTools',
  json('["mcp__plex__*"]')
) WHERE folder = 'whatsapp_entertainment';
