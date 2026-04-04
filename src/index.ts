import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  ADMIN_JIDS,
  ASSISTANT_NAME,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { startLogPruner } from './log-pruner.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getIgnoredGroupJids,
  getLastBotMessageTimestamp,
  getMessageFromMe,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  logTokenUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { McpBridge } from './mcp-bridge.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { ChannelType } from './text-styles.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { StatusTracker } from './status-tracker.js';
import { parseImageReferences } from './image.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let replyToMessageIds: Record<string, string | undefined> = {};
// Tracks cursor value before messages were piped to an active container.
// Used to roll back if the container dies after piping.
let cursorBeforePipe: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let statusTracker: StatusTracker;

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  const pipeCursor = getRouterState('cursor_before_pipe');
  try {
    cursorBeforePipe = pipeCursor ? JSON.parse(pipeCursor) : {};
  } catch {
    logger.warn('Corrupted cursor_before_pipe in DB, resetting');
    cursorBeforePipe = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState('cursor_before_pipe', JSON.stringify(cursorBeforePipe));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  const ignoredJids = getIgnoredGroupJids();

  return chats
    .filter(
      (c) =>
        c.jid !== '__group_sync__' && c.is_group && !ignoredJids.has(c.jid),
    )
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // Find the message to reply to (for thread support).
  // Look for the last message that is itself a thread reply — reply to that
  // so the bot's response stays in the same thread.
  const threadedMsg = [...missedMessages]
    .reverse()
    .find((m) => m.thread_message_id);
  replyToMessageIds[chatJid] = threadedMsg?.id;

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: getTriggerPattern(group.trigger),
    timezone: TIMEZONE,
    adminJids: ADMIN_JIDS,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, [], onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      advanceCursor: (ts) => {
        lastAgentTimestamp[chatJid] = ts;
        saveState();
      },
      formatMessages,
      canSenderInteract: (msg) => {
        const hasTrigger = getTriggerPattern(group.trigger).test(
          msg.content.trim(),
        );
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  // Ensure all user messages are tracked — recovery messages enter processGroupMessages
  // directly via the queue, bypassing startMessageLoop where markReceived normally fires.
  // markReceived is idempotent (rejects duplicates), so this is safe for normal-path messages too.
  for (const msg of missedMessages) {
    statusTracker.markReceived(msg.id, chatJid, false, msg.sender);
  }

  // Mark all user messages as thinking (container is spawning)
  const userMessages = missedMessages.filter(
    (m) => !m.is_from_me && !m.is_bot_message,
  );
  for (const msg of userMessages) {
    statusTracker.markThinking(msg.id);
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);
  const imageAttachments = parseImageReferences(missedMessages);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error or crash.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  cursorBeforePipe[chatJid] = previousCursor;
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let firstOutputSeen = false;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    imageAttachments,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        if (!firstOutputSeen) {
          firstOutputSeen = true;
          for (const um of userMessages) {
            statusTracker.markWorking(um.id);
          }
        }
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);
        if (text) {
          await channel.sendMessage(chatJid, text, replyToMessageIds[chatJid]);
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        statusTracker.markAllDone(chatJid);
        // Clear pipe rollback cursor now that output was delivered.
        // Don't wait for processGroupMessages to return — if the process
        // dies between here and the return, we'd wrongly roll back.
        delete cursorBeforePipe[chatJid];
        saveState();
        queue.notifyIdle(chatJid);
      }

      if (
        result.status === 'success' &&
        (result.usage || result.total_cost_usd !== undefined)
      ) {
        logTokenUsage({
          chat_jid: chatJid,
          group_folder: group.folder,
          timestamp: new Date().toISOString(),
          input_tokens: result.usage?.input_tokens ?? null,
          output_tokens: result.usage?.output_tokens ?? null,
          total_cost_usd: result.total_cost_usd ?? null,
          modelUsage: result.modelUsage,
        });
      }

      if (result.status === 'error') {
        hadError = true;
        // Clear invalid session so next attempt starts fresh
        if (
          result.error?.includes('No conversation found with session ID') &&
          sessions[group.folder]
        ) {
          logger.info(
            { group: group.name, folder: group.folder },
            'Clearing invalid session after "not found" error',
          );
          delete sessions[group.folder];
          setSession(group.folder, '');
        }
      }
    },
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      // Output was sent for the initial batch, so don't roll those back.
      // But if messages were piped AFTER that output, roll back to recover them.
      if (cursorBeforePipe[chatJid]) {
        lastAgentTimestamp[chatJid] = cursorBeforePipe[chatJid];
        delete cursorBeforePipe[chatJid];
        saveState();
        logger.warn(
          { group: group.name },
          'Agent error after output, rolled back piped messages for retry',
        );
        statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
        return false;
      }
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, no piped messages to recover',
      );
      statusTracker.markAllDone(chatJid);
      return true;
    }
    // No output sent — roll back everything so the full batch is retried
    lastAgentTimestamp[chatJid] = previousCursor;
    delete cursorBeforePipe[chatJid];
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    statusTracker.markAllFailed(chatJid, 'Task crashed — retrying.');
    return false;
  }

  // Success — clear pipe tracking (markAllDone already fired in streaming callback)
  delete cursorBeforePipe[chatJid];
  saveState();
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        ...(imageAttachments.length > 0 && { imageAttachments }),
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );

      // If the session ID is no longer valid (e.g. directory was renamed,
      // session files were cleaned up), clear it so the next attempt starts fresh
      // instead of looping on the same dead session.
      if (
        output.error?.includes('No conversation found with session ID') &&
        sessions[group.folder]
      ) {
        logger.info(
          { group: group.name, folder: group.folder },
          'Clearing invalid session after "not found" error',
        );
        delete sessions[group.folder];
        setSession(group.folder, '');
      }

      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = groupMessages.find(
            (m) =>
              extractSessionCommand(
                m.content,
                getTriggerPattern(group.trigger),
              ) !== null,
          );

          if (loopCmdMsg) {
            // Only close active container if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no container is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
                loopCmdMsg.sender,
                ADMIN_JIDS,
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh container with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Mark each user message as received (status emoji)
          for (const msg of groupMessages) {
            if (!msg.is_from_me && !msg.is_bot_message) {
              statusTracker.markReceived(msg.id, chatJid, false, msg.sender);
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            // Update reply-to for piped messages (thread awareness)
            const threadedPiped = [...messagesToSend]
              .reverse()
              .find((m) => m.thread_message_id);
            replyToMessageIds[chatJid] = threadedPiped?.id;
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Mark new user messages as thinking (only groupMessages were markReceived'd;
            // accumulated allPending context messages are untracked and would no-op)
            for (const msg of groupMessages) {
              if (!msg.is_from_me && !msg.is_bot_message) {
                statusTracker.markThinking(msg.id);
              }
            }
            // Save cursor before first pipe so we can roll back if container dies
            if (!cursorBeforePipe[chatJid]) {
              cursorBeforePipe[chatJid] = lastAgentTimestamp[chatJid] || '';
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  // Roll back any piped-message cursors that were persisted before a crash.
  // This ensures messages piped to a now-dead container are re-fetched.
  // IMPORTANT: Only roll back if the container is no longer running — rolling
  // back while the container is alive causes duplicate processing.
  let rolledBack = false;
  for (const [chatJid, savedCursor] of Object.entries(cursorBeforePipe)) {
    if (queue.isActive(chatJid)) {
      logger.debug(
        { chatJid },
        'Recovery: skipping piped-cursor rollback, container still active',
      );
      continue;
    }
    logger.info(
      { chatJid, rolledBackTo: savedCursor },
      'Recovery: rolling back piped-message cursor',
    );
    lastAgentTimestamp[chatJid] = savedCursor;
    delete cursorBeforePipe[chatJid];
    // Clear session so recovery starts a fresh container instead of resuming
    // a potentially huge session that will churn without producing output.
    const group = registeredGroups[chatJid];
    if (group?.folder && sessions[group.folder]) {
      logger.info(
        { chatJid, folder: group.folder },
        'Recovery: clearing stale session',
      );
      delete sessions[group.folder];
      setSession(group.folder, '');
    }
    rolledBack = true;
  }
  if (rolledBack) {
    saveState();
  }

  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  startLogPruner(GROUPS_DIR);
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    // Clear piped-message rollback cursors on clean shutdown.
    // Containers are detached (not killed), so their work is done or abandoned.
    // Without this, recovery rolls back cursors and re-processes handled messages.
    cursorBeforePipe = {};
    saveState();
    for (const ch of channels) await ch.disconnect();
    mcpBridge.stop();
    await statusTracker.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Initialize status tracker (uses channels via callbacks, channels don't need to be connected yet)
  statusTracker = new StatusTracker({
    sendReaction: async (chatJid, messageKey, emoji) => {
      const channel = findChannel(channels, chatJid);
      if (!channel?.sendReaction) return;
      await channel.sendReaction(chatJid, messageKey, emoji);
    },
    sendMessage: async (chatJid, text) => {
      const channel = findChannel(channels, chatJid);
      if (!channel) return;
      await channel.sendMessage(chatJid, text);
    },
    isMainGroup: (chatJid) => {
      const group = registeredGroups[chatJid];
      return group?.isMain === true;
    },
    isContainerAlive: (chatJid) => queue.isActive(chatJid),
  });

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  // Initialize MCP bridge for host-side MCP servers that can't run in containers
  const mcpBridge = new McpBridge();
  {
    const { readEnvFile } = await import('./env.js');
    const envKeys = ['MCP_BRIDGE_SERVERS'];
    const env = readEnvFile(envKeys);
    const serverNames = (env.MCP_BRIDGE_SERVERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (serverNames.length > 0) {
      // Read per-server config: MCP_BRIDGE_{NAME}_COMMAND, _ARGS, _ENV_{KEY}
      const serverEnvKeys = serverNames.flatMap((name) => {
        const prefix = `MCP_BRIDGE_${name.toUpperCase().replace(/-/g, '_')}`;
        return [`${prefix}_COMMAND`, `${prefix}_ARGS`];
      });
      const serverEnv = readEnvFile(serverEnvKeys);

      for (const name of serverNames) {
        const prefix = `MCP_BRIDGE_${name.toUpperCase().replace(/-/g, '_')}`;
        const command = serverEnv[`${prefix}_COMMAND`];
        if (!command) {
          logger.warn(
            { server: name },
            `MCP bridge server "${name}" missing ${prefix}_COMMAND, skipping`,
          );
          continue;
        }

        const argsStr = serverEnv[`${prefix}_ARGS`];
        const args = argsStr ? argsStr.split(' ').filter(Boolean) : undefined;

        mcpBridge.addServer({ name, command, args });
      }
    }
  }

  startIpcWatcher({
    sendMessage: (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      const text = formatOutbound(rawText, channel.name as ChannelType);
      if (!text) return Promise.resolve();
      return channel.sendMessage(jid, text);
    },
    sendReaction: async (jid, emoji, messageId) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (messageId) {
        if (!channel.sendReaction)
          throw new Error('Channel does not support sendReaction');
        const msgInfo = getMessageFromMe(messageId, jid);
        const messageKey: {
          id: string;
          remoteJid: string;
          fromMe: boolean;
          participant?: string;
        } = {
          id: messageId,
          remoteJid: jid,
          fromMe: msgInfo.fromMe,
        };
        if (jid.endsWith('@g.us') && msgInfo.sender) {
          messageKey.participant = msgInfo.sender;
        }
        await channel.sendReaction(jid, messageKey, emoji);
      } else {
        if (!channel.reactToLatestMessage)
          throw new Error('Channel does not support reactions');
        await channel.reactToLatestMessage(jid, emoji);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    mcpBridge: mcpBridge.hasServers() ? mcpBridge : undefined,
    statusHeartbeat: () => statusTracker.heartbeatCheck(),
    recoverPendingMessages,
  });
  // Recover status tracker AFTER channels connect, so recovery reactions
  // can actually be sent via the WhatsApp channel.
  await statusTracker.recover();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
