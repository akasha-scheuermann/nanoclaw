/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const AGENT_REQUESTS_DIR = path.join(IPC_DIR, 'agent_requests');
const AGENT_RESPONSES_DIR = path.join(IPC_DIR, 'agent_responses');
const WORK_ITEM_RESPONSES_DIR = path.join(IPC_DIR, 'work_item_responses');
const REACTION_RESPONSES_DIR = path.join(IPC_DIR, 'reaction_responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

// ── MCP Tool Allowlist ──────────────────────────────────────────────────
// Reads UNIVERSAL_MCP_ALLOWLIST (comma-separated) and ALLOWED_MCP_TOOLS
// (JSON array) from env. Only tools matching these patterns are registered.
// Empty allowlist = no tools registered (secure by default).

function buildToolAllowlist(): string[] {
  const patterns: string[] = [];

  const universal = process.env.UNIVERSAL_MCP_ALLOWLIST;
  if (universal) {
    for (const tool of universal.split(',').map(t => t.trim()).filter(Boolean)) {
      patterns.push(tool);
    }
  }

  const perGroup = process.env.ALLOWED_MCP_TOOLS;
  if (perGroup) {
    try {
      const parsed = JSON.parse(perGroup);
      if (Array.isArray(parsed)) {
        for (const tool of parsed) {
          if (typeof tool === 'string' && tool.trim()) {
            patterns.push(tool.trim());
          }
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  return patterns;
}

/**
 * Check if a tool name matches the allowlist patterns.
 * Patterns support trailing wildcards (e.g., "calendar_*" matches "calendar_list_events").
 * If no allowlist is configured (both env vars unset), all tools are allowed (backwards compat).
 */
function isToolAllowed(toolName: string): boolean {
  // If neither env var is set at all, allow everything (backwards compat)
  if (
    process.env.UNIVERSAL_MCP_ALLOWLIST === undefined &&
    process.env.ALLOWED_MCP_TOOLS === undefined
  ) {
    return true;
  }

  const allowlist = buildToolAllowlist();
  if (allowlist.length === 0) return false;

  // Strip mcp__server__ prefix if present (bridged tools come as raw names,
  // but patterns might be fully qualified)
  const rawName = toolName.replace(/^mcp__[^_]+__/, '');

  for (const pattern of allowlist) {
    // Also strip mcp__ prefix from pattern for comparison
    const rawPattern = pattern.replace(/^mcp__[^_]+__/, '');

    if (rawPattern === rawName) return true;

    // Glob wildcard: "calendar_*" matches "calendar_list_events"
    if (rawPattern.endsWith('*')) {
      const prefix = rawPattern.slice(0, -1);
      if (rawName.startsWith(prefix)) return true;
    }
  }

  return false;
}


function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z
      .string()
      .describe('The emoji to react with (e.g. "👍", "❤️", "🔥")'),
    message_id: z
      .string()
      .optional()
      .describe(
        'The message ID to react to. If omitted, reacts to the latest message in the chat.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [
        { type: 'text' as const, text: `Reaction ${args.emoji} sent.` },
      ],
    };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      const allTasks: Array<{
        id: string;
        groupFolder: string;
        prompt: string;
        schedule_type: string;
        schedule_value: string;
        status: string;
        next_run: string;
      }> = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'call_agent',
  'Call another agent and wait for a response. The target agent runs in isolated mode (fresh session, no conversation history) with your prompt. Use for cross-agent queries like asking a domain agent for status or data.\n\nThe target agent runs in its own container with its own tools, mounts, and CLAUDE.md. The response is the text output from that agent. Timeout is 300 seconds by default (the target needs time to spin up).\n\nTarget agents are identified by their group folder name (e.g., "whatsapp_research", "whatsapp_planning").',
  {
    target_group: z.string().describe('Group folder name of the target agent (e.g., "whatsapp_research", "whatsapp_support")'),
    prompt: z.string().describe('The instruction/question to send to the target agent'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5 minutes)'),
  },
  async (args: { target_group: string; prompt: string; timeout?: number }) => {
    fs.mkdirSync(AGENT_REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(AGENT_RESPONSES_DIR, { recursive: true });

    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const request = {
      requestId,
      targetGroup: args.target_group,
      prompt: args.prompt,
      timeout: args.timeout || 300_000,
      timestamp: new Date().toISOString(),
    };

    // Atomic write
    const reqPath = path.join(AGENT_REQUESTS_DIR, `${requestId}.json`);
    const tmpPath = `${reqPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(request));
    fs.renameSync(tmpPath, reqPath);

    // Poll for response
    const respPath = path.join(AGENT_RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + (args.timeout || 300_000);
    const POLL_INTERVAL = 500;

    while (Date.now() < deadline) {
      if (fs.existsSync(respPath)) {
        const data = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
        fs.unlinkSync(respPath);

        if (data.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${data.error}` }] };
        }
        return { content: [{ type: 'text' as const, text: data.result || '(no output from agent)' }] };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return {
      content: [{ type: 'text' as const, text: `Error: Agent call timed out after ${args.timeout || 120_000}ms. The target agent may still be processing.` }]
    };
  },
);

server.tool(
  'create_work_item',
  `Add a new item to this agent's work queue. Call this at the START of an initiative loop session to register the work you are about to do.

Items flow through statuses: queued → in_progress → done (or blocked/deferred).
The host enforces WIP limits — you cannot move an item to in_progress if you are already at your limit.

source examples: "initiative_loop", "manual", "vault:path/to/project.md"`,
  {
    title: z.string().describe('Short title for the work item (1 line)'),
    description: z
      .string()
      .optional()
      .describe('Longer description of the work to be done'),
    priority: z
      .number()
      .optional()
      .describe('Priority 0–100, higher = more urgent. Default: 50'),
    source: z
      .string()
      .optional()
      .describe(
        'Where this work came from (e.g. "initiative_loop", "vault:path/to/project.md")',
      ),
    reasoning: z
      .string()
      .optional()
      .describe('Why you chose this work item this session'),
  },
  async (args) => {
    fs.mkdirSync(WORK_ITEM_RESPONSES_DIR, { recursive: true });

    const requestId = `wi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'create_work_item',
      requestId,
      workItemTitle: args.title,
      workItemDescription: args.description,
      workItemPriority: args.priority,
      workItemSource: args.source,
      workItemReasoning: args.reasoning,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const respPath = path.join(WORK_ITEM_RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    const POLL_INTERVAL = 200;

    while (Date.now() < deadline) {
      if (fs.existsSync(respPath)) {
        const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
        fs.unlinkSync(respPath);
        return {
          content: [
            {
              type: 'text' as const,
              text: result.success
                ? `Work item created (id: ${result.id})`
                : `Failed: ${result.error}`,
            },
          ],
          isError: !result.success,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for work item creation.' }],
      isError: true,
    };
  },
);

server.tool(
  'update_work_item',
  `Update the status or details of a work item. Use this to transition items through their lifecycle:
- queued → in_progress (when starting work; WIP limit enforced by host)
- in_progress → done (when work is complete; include outcome)
- in_progress → blocked (when you cannot proceed; include blocked_reason)
- in_progress → deferred (when deprioritizing)

Always set outcome when marking done. Always set blocked_reason when marking blocked.`,
  {
    id: z.number().describe('The work item ID (from create_work_item or list_work_items)'),
    status: z
      .enum(['queued', 'in_progress', 'done', 'blocked', 'deferred'])
      .optional()
      .describe('New status'),
    outcome: z
      .string()
      .optional()
      .describe('What was produced or accomplished (set when marking done)'),
    blocked_reason: z
      .string()
      .optional()
      .describe('Why work is blocked (set when marking blocked)'),
    reasoning: z.string().optional().describe('Updated reasoning notes'),
  },
  async (args) => {
    fs.mkdirSync(WORK_ITEM_RESPONSES_DIR, { recursive: true });

    const requestId = `wi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'update_work_item',
      requestId,
      workItemId: args.id,
      workItemStatus: args.status,
      workItemOutcome: args.outcome,
      workItemBlockedReason: args.blocked_reason,
      workItemReasoning: args.reasoning,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const respPath = path.join(WORK_ITEM_RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    const POLL_INTERVAL = 200;

    while (Date.now() < deadline) {
      if (fs.existsSync(respPath)) {
        const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
        fs.unlinkSync(respPath);
        return {
          content: [
            {
              type: 'text' as const,
              text: result.success
                ? `Work item ${args.id} updated.`
                : `Failed: ${result.error}`,
            },
          ],
          isError: !result.success,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for work item update.' }],
      isError: true,
    };
  },
);

server.tool(
  'list_work_items',
  "List this agent's work queue. Use at the start of an initiative loop session to check current WIP and backlog before selecting new work.",
  {
    status_filter: z
      .array(z.enum(['queued', 'in_progress', 'done', 'blocked', 'deferred']))
      .optional()
      .describe(
        'Filter by status. Omit to see all items. Tip: use ["queued","in_progress","blocked"] to see active work.',
      ),
  },
  async (args) => {
    fs.mkdirSync(WORK_ITEM_RESPONSES_DIR, { recursive: true });

    const requestId = `wi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'list_work_items',
      requestId,
      workItemStatusFilter: args.status_filter,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const respPath = path.join(WORK_ITEM_RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    const POLL_INTERVAL = 200;

    while (Date.now() < deadline) {
      if (fs.existsSync(respPath)) {
        const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
        fs.unlinkSync(respPath);
        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
            isError: true,
          };
        }
        if (result.items.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No work items found.' }],
          };
        }
        const formatted = result.items
          .map(
            (item: {
              id: number;
              title: string;
              status: string;
              priority: number;
              source: string | null;
              reasoning: string | null;
              outcome: string | null;
              blocked_reason: string | null;
              created_at: number;
            }) => {
              const lines = [
                `[${item.id}] ${item.title} — ${item.status} (priority: ${item.priority})`,
              ];
              if (item.source) lines.push(`  source: ${item.source}`);
              if (item.reasoning) lines.push(`  reasoning: ${item.reasoning}`);
              if (item.outcome) lines.push(`  outcome: ${item.outcome}`);
              if (item.blocked_reason) lines.push(`  blocked: ${item.blocked_reason}`);
              return lines.join('\n');
            },
          )
          .join('\n\n');
        return {
          content: [{ type: 'text' as const, text: `Work items:\n\n${formatted}` }],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for work item list.' }],
      isError: true,
    };
  },
);

server.tool(
  'get_reaction_summary',
  `Get a summary of reactions on your recent messages.

Returns two views:
- summary: reaction counts grouped by emoji, with sample message snippets for each emoji
- recent: the most recent individual reactions in chronological order, each with any thread replies the user added in the same thread

Each item in recent includes:
- emoji: the reaction emoji
- reactor_name: who reacted
- timestamp: when they reacted
- message_snippet: first 120 chars of the reacted-to message
- thread_replies: array of { sender_name, content, timestamp } for any replies in that thread`,
  {
    days: z
      .number()
      .optional()
      .describe('How many days to look back (default: 30)'),
    limit: z
      .number()
      .optional()
      .describe('Max recent reactions to return (default: 20)'),
  },
  async (args) => {
    fs.mkdirSync(REACTION_RESPONSES_DIR, { recursive: true });

    const requestId = `rxn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'get_reaction_summary',
      requestId,
      reactionDays: args.days,
      reactionLimit: args.limit,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const respPath = path.join(REACTION_RESPONSES_DIR, `${requestId}.json`);
    const deadline = Date.now() + 10_000;
    const POLL_INTERVAL = 200;

    while (Date.now() < deadline) {
      if (fs.existsSync(respPath)) {
        const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
        fs.unlinkSync(respPath);

        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `Failed: ${result.error}` }],
            isError: true,
          };
        }

        const lines: string[] = [];

        if (result.summary.length === 0) {
          lines.push('No reactions found in the specified window.');
        } else {
          lines.push('*Reaction summary:*');
          for (const entry of result.summary as Array<{
            emoji: string;
            count: number;
            last_seen: string;
            sample_messages: string[];
          }>) {
            lines.push(`\n${entry.emoji}  ×${entry.count}  (last: ${entry.last_seen.slice(0, 10)})`);
            for (const snippet of entry.sample_messages) {
              lines.push(`  → "${snippet.trim()}"`);
            }
          }
        }

        if (result.recent && result.recent.length > 0) {
          lines.push('\n*Recent reactions:*');
          for (const r of result.recent as Array<{
            emoji: string;
            reactor_name: string | null;
            timestamp: string;
            message_snippet: string;
            thread_replies: Array<{ sender_name: string | null; content: string; timestamp: string }>;
          }>) {
            const who = r.reactor_name || 'unknown';
            lines.push(`${r.emoji} ${who} — "${r.message_snippet.trim()}" (${r.timestamp.slice(0, 10)})`);
            if (r.thread_replies && r.thread_replies.length > 0) {
              for (const reply of r.thread_replies) {
                const replyWho = reply.sender_name || 'unknown';
                lines.push(`  💬 ${replyWho}: "${reply.content.trim()}"`);
              }
            }
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    return {
      content: [{ type: 'text' as const, text: 'Timed out waiting for reaction summary.' }],
      isError: true,
    };
  },
);

if (isMain) {
  server.tool(
    'restart_nanoclaw',
    'Restart the NanoClaw host process. The host will rebuild TypeScript (npm run build) before restarting, so any source edits take effect. Use after editing source code, after config changes, or when the system is misbehaving.',
    {},
    async () => {
      const data = {
        type: 'restart_nanoclaw',
        groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      return {
        content: [
          {
            type: 'text' as const,
            text: 'NanoClaw restart requested. The host will build TypeScript and restart via the service manager.',
          },
        ],
      };
    },
  );

  server.tool(
    'snapshot_groups',
    'Commit and push any changes in a repo to GitHub. Defaults to the groups/ userland repo. Pass repoPath to snapshot a different allowlisted repo (e.g. ~/Code/System/akasha-scripts). Skips cleanly if nothing has changed.',
    {
      message: z.string().optional().describe('Commit message describing what changed'),
      repoPath: z.string().optional().describe('Absolute path to a repo to snapshot instead of groups/ (must be allowlisted on host)'),
    },
    async ({ message, repoPath }) => {
      const SNAPSHOT_RESPONSES_DIR = path.join(IPC_DIR, 'snapshot_responses');
      fs.mkdirSync(SNAPSHOT_RESPONSES_DIR, { recursive: true });

      const requestId = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = {
        type: 'snapshot_groups',
        groupFolder,
        requestId,
        message: message || 'chore: snapshot agent workspaces',
        ...(repoPath ? { repoPath } : {}),
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      // Poll for result
      const respPath = path.join(SNAPSHOT_RESPONSES_DIR, `${requestId}.json`);
      const deadline = Date.now() + 30_000; // 30 seconds
      const POLL_INTERVAL = 500;

      while (Date.now() < deadline) {
        if (fs.existsSync(respPath)) {
          const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
          fs.unlinkSync(respPath);
          return {
            content: [
              {
                type: 'text' as const,
                text: result.success
                  ? `✓ ${result.output}`
                  : `Snapshot failed: ${result.error}`,
              },
            ],
          };
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }

      return {
        content: [{ type: 'text' as const, text: 'Snapshot timed out. Check host logs.' }],
      };
    },
  );

  server.tool(
    'rebuild_container',
    'Rebuild the NanoClaw agent container image on the host. Use after editing container source (agent-runner/, Dockerfile, container skills). The build runs on the host (not inside a container), so native dependencies are built for the correct architecture. New containers will use the updated image on next spawn.',
    {},
    async () => {
      const BUILD_RESPONSES_DIR = path.join(IPC_DIR, 'build_responses');
      fs.mkdirSync(BUILD_RESPONSES_DIR, { recursive: true });

      const requestId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const data = {
        type: 'rebuild_container',
        groupFolder,
        requestId,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      // Poll for build result
      const respPath = path.join(BUILD_RESPONSES_DIR, `${requestId}.json`);
      const deadline = Date.now() + 300_000; // 5 minutes
      const POLL_INTERVAL = 1000;

      while (Date.now() < deadline) {
        if (fs.existsSync(respPath)) {
          const result = JSON.parse(fs.readFileSync(respPath, 'utf-8'));
          fs.unlinkSync(respPath);

          if (result.success) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Container rebuild completed successfully.\n\n${result.output || ''}`,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Container rebuild failed: ${result.error}`,
                },
              ],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Container rebuild timed out after 5 minutes. Check host logs for details.',
          },
        ],
      };
    },
  );
}

// --- MCP Bridge: dynamically discover and proxy host-side MCP tools ---

const MCP_REQUESTS_DIR = path.join(IPC_DIR, 'mcp_requests');
const MCP_RESPONSES_DIR = path.join(IPC_DIR, 'mcp_responses');
const MCP_BRIDGE_POLL_INTERVAL = 100; // ms
const MCP_BRIDGE_TIMEOUT = 30_000; // ms

async function callHostMcp(
  serverName: string,
  tool: string,
  args: Record<string, unknown>,
  type?: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  fs.mkdirSync(MCP_REQUESTS_DIR, { recursive: true });

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestFile = path.join(MCP_REQUESTS_DIR, `${requestId}.json`);
  const tempFile = `${requestFile}.tmp`;

  // Write request atomically
  const request: Record<string, unknown> = {
    requestId,
    server: serverName,
    tool,
    args,
  };
  if (type) request.type = type;

  fs.writeFileSync(tempFile, JSON.stringify(request));
  fs.renameSync(tempFile, requestFile);

  // Poll for response
  const responseFile = path.join(MCP_RESPONSES_DIR, `${requestId}.json`);
  const start = Date.now();

  while (Date.now() - start < MCP_BRIDGE_TIMEOUT) {
    if (fs.existsSync(responseFile)) {
      const raw = fs.readFileSync(responseFile, 'utf-8');
      fs.unlinkSync(responseFile);
      const response = JSON.parse(raw);
      if (response.error) {
        return {
          content: [
            { type: 'text', text: `Error: ${response.error}` },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(response.result),
          },
        ],
      };
    }
    await new Promise((r) => setTimeout(r, MCP_BRIDGE_POLL_INTERVAL));
  }

  return {
    content: [{ type: 'text', text: 'Error: MCP bridge request timed out' }],
  };
}

// Discover bridged tools from host and register them dynamically.
// Only attempts discovery if the host wrote a bridge manifest file,
// avoiding a 30s timeout on every container spawn when no bridge is configured.
async function registerBridgedTools(): Promise<void> {
  const manifestFile = path.join(IPC_DIR, 'mcp_bridge_enabled');
  if (!fs.existsSync(manifestFile)) return;

  try {
    const result = await callHostMcp('', '', {}, 'list_tools');
    const text = result.content[0]?.text;
    if (!text || text.startsWith('Error:')) return;

    const serverTools: Array<{
      server: string;
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: {
          type: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      }>;
    }> = JSON.parse(text);

    for (const entry of serverTools) {
      const serverName = entry.server;
      for (const tool of entry.tools) {
        // Build zod schema from JSON Schema properties
        const zodSchema: Record<string, z.ZodType> = {};
        const props = tool.inputSchema?.properties || {};
        const requiredFields = new Set(tool.inputSchema?.required || []);

        for (const [key, schemaDef] of Object.entries(props)) {
          const def = schemaDef as {
            type?: string;
            description?: string;
            enum?: string[];
            items?: { type?: string };
          };
          let zodType: z.ZodType;

          // Map JSON Schema types to zod
          switch (def.type) {
            case 'number':
            case 'integer':
              zodType = z.number();
              break;
            case 'boolean':
              zodType = z.boolean();
              break;
            case 'array':
              if (def.items?.type === 'number') {
                zodType = z.array(z.number());
              } else {
                zodType = z.array(z.string());
              }
              break;
            default:
              // string, or unknown — treat as string
              if (def.enum) {
                zodType = z.enum(def.enum as [string, ...string[]]);
              } else {
                zodType = z.string();
              }
          }

          if (def.description) {
            zodType = zodType.describe(def.description);
          }

          if (!requiredFields.has(key)) {
            zodType = zodType.optional();
          }

          zodSchema[key] = zodType;
        }

        // Filter bridged tools against the allowlist
        if (!isToolAllowed(tool.name)) continue;

        server.tool(
          tool.name,
          tool.description || `Bridged tool: ${tool.name}`,
          zodSchema,
          async (args: Record<string, unknown>) => {
            return callHostMcp(serverName, tool.name, args);
          },
        );
      }
    }
  } catch {
    // No bridged tools available — not an error, bridge may not be configured
  }
}

await registerBridgedTools();

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
