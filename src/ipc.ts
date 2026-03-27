import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup, runContainerAgent } from './container-runner.js';
import {
  createTask,
  createWorkItem,
  deleteTask,
  getTaskById,
  listWorkItems,
  updateTask,
  updateWorkItem,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { McpBridge } from './mcp-bridge.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendReaction?: (
    jid: string,
    emoji: string,
    messageId?: string,
  ) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  mcpBridge?: McpBridge;
  statusHeartbeat?: () => void;
  recoverPendingMessages?: () => void;
}

let ipcWatcherRunning = false;
const RECOVERY_INTERVAL_MS = 60_000;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  let lastRecoveryTime = Date.now();

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'reaction' &&
                data.chatJid &&
                data.emoji &&
                deps.sendReaction
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  try {
                    await deps.sendReaction(
                      data.chatJid,
                      data.emoji,
                      data.messageId,
                    );
                    logger.info(
                      { chatJid: data.chatJid, emoji: data.emoji, sourceGroup },
                      'IPC reaction sent',
                    );
                  } catch (err) {
                    logger.error(
                      {
                        chatJid: data.chatJid,
                        emoji: data.emoji,
                        sourceGroup,
                        err,
                      },
                      'IPC reaction failed',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC reaction attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process MCP bridge requests from this group's IPC directory
      if (deps.mcpBridge) {
        const requestsDir = path.join(ipcBaseDir, sourceGroup, 'mcp_requests');
        const responsesDir = path.join(
          ipcBaseDir,
          sourceGroup,
          'mcp_responses',
        );
        try {
          if (fs.existsSync(requestsDir)) {
            const requestFiles = fs
              .readdirSync(requestsDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of requestFiles) {
              const filePath = path.join(requestsDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                fs.unlinkSync(filePath);

                // Process async — write response when done
                processMcpRequest(
                  deps.mcpBridge,
                  data,
                  responsesDir,
                  sourceGroup,
                );
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error reading MCP bridge request',
                );
                fs.unlinkSync(filePath);
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading MCP requests directory',
          );
        }
      }

      // Process cross-agent call requests
      const agentRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'agent_requests',
      );
      const agentResponsesDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'agent_responses',
      );
      try {
        if (fs.existsSync(agentRequestsDir)) {
          const requestFiles = fs
            .readdirSync(agentRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of requestFiles) {
            const filePath = path.join(agentRequestsDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              fs.unlinkSync(filePath);
              processAgentCallRequest(
                data,
                agentResponsesDir,
                sourceGroup,
                registeredGroups,
                deps.sendMessage,
              );
            } catch (err) {
              logger.error(
                { file, error: err },
                'Failed to process agent call request',
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { sourceGroup, error: err },
          'Failed to scan agent requests',
        );
      }
    }

    // Status emoji heartbeat — detect dead containers with stale emoji state
    deps.statusHeartbeat?.();

    // Periodic message recovery — catch stuck messages after retry exhaustion or pipeline stalls
    const now = Date.now();
    if (now - lastRecoveryTime >= RECOVERY_INTERVAL_MS) {
      lastRecoveryTime = now;
      deps.recoverPendingMessages?.();
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For rebuild_container / snapshot_groups
    requestId?: string;
    // For snapshot_groups
    message?: string;
    // For work items
    workItemId?: number;
    workItemTitle?: string;
    workItemDescription?: string;
    workItemStatus?: string;
    workItemPriority?: number;
    workItemSource?: string;
    workItemReasoning?: string;
    workItemOutcome?: string;
    workItemBlockedReason?: string;
    workItemStatusFilter?: string[];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'restart_nanoclaw':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized restart_nanoclaw attempt blocked',
        );
        break;
      }
      logger.info({ sourceGroup }, 'NanoClaw restart requested via IPC');
      // Build TypeScript on the host before restarting so source edits take effect.
      // This runs on macOS (not inside a container) so native modules stay intact.
      try {
        logger.info('Running npm run build before restart');
        execSync('npm run build', {
          cwd: process.cwd(),
          timeout: 30_000,
          stdio: 'pipe',
        });
        logger.info('TypeScript build completed');
      } catch (err) {
        logger.error(
          { err },
          'TypeScript build failed — restarting with existing dist/',
        );
      }
      // Brief delay to let IPC cleanup finish, then exit — launchd/systemd restarts us
      setTimeout(() => {
        logger.info('Exiting for restart');
        process.exit(0);
      }, 1500);
      break;

    case 'rebuild_container': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized rebuild_container attempt blocked',
        );
        break;
      }
      logger.info({ sourceGroup }, 'Container rebuild requested via IPC');
      const buildScript = path.join(process.cwd(), 'container', 'build.sh');
      try {
        const output = execSync(buildScript, {
          cwd: process.cwd(),
          timeout: 300_000, // 5 minutes
          stdio: 'pipe',
        });
        logger.info('Container rebuild completed');
        // Write result to IPC response file if requestId provided
        if (data.requestId) {
          const responseDir = path.join(
            DATA_DIR,
            'ipc',
            sourceGroup,
            'build_responses',
          );
          fs.mkdirSync(responseDir, { recursive: true });
          fs.writeFileSync(
            path.join(responseDir, `${data.requestId}.json`),
            JSON.stringify({
              success: true,
              output: output.toString().slice(-500),
            }),
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'Container rebuild failed');
        if (data.requestId) {
          const responseDir = path.join(
            DATA_DIR,
            'ipc',
            sourceGroup,
            'build_responses',
          );
          fs.mkdirSync(responseDir, { recursive: true });
          fs.writeFileSync(
            path.join(responseDir, `${data.requestId}.json`),
            JSON.stringify({ success: false, error: errMsg }),
          );
        }
      }
      break;
    }

    case 'snapshot_groups': {
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized snapshot_groups attempt blocked',
        );
        break;
      }
      const commitMessage = data.message || 'chore: snapshot agent workspaces';
      const groupsDir = path.join(process.cwd(), 'groups');
      const SNAPSHOT_RESPONSES_DIR = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'snapshot_responses',
      );
      logger.info({ sourceGroup, commitMessage }, 'Groups snapshot requested');
      try {
        execSync('git add -A', { cwd: groupsDir, stdio: 'pipe' });
        // Check if there's anything to commit
        let nothingToCommit = false;
        try {
          execSync('git diff --cached --quiet', {
            cwd: groupsDir,
            stdio: 'pipe',
          });
          nothingToCommit = true;
        } catch {
          // non-zero exit = staged changes exist
        }
        if (nothingToCommit) {
          logger.info('snapshot_groups: nothing to commit');
          if (data.requestId) {
            fs.mkdirSync(SNAPSHOT_RESPONSES_DIR, { recursive: true });
            fs.writeFileSync(
              path.join(SNAPSHOT_RESPONSES_DIR, `${data.requestId}.json`),
              JSON.stringify({ success: true, output: 'Nothing to commit.' }),
            );
          }
          break;
        }
        execSync(`git commit -m ${JSON.stringify(commitMessage)}`, {
          cwd: groupsDir,
          stdio: 'pipe',
        });
        execSync('git push', {
          cwd: groupsDir,
          timeout: 30_000,
          stdio: 'pipe',
        });
        logger.info('snapshot_groups: committed and pushed');
        if (data.requestId) {
          fs.mkdirSync(SNAPSHOT_RESPONSES_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(SNAPSHOT_RESPONSES_DIR, `${data.requestId}.json`),
            JSON.stringify({
              success: true,
              output: `Committed: ${commitMessage}`,
            }),
          );
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'snapshot_groups failed');
        if (data.requestId) {
          fs.mkdirSync(SNAPSHOT_RESPONSES_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(SNAPSHOT_RESPONSES_DIR, `${data.requestId}.json`),
            JSON.stringify({ success: false, error: errMsg }),
          );
        }
      }
      break;
    }

    case 'create_work_item': {
      if (!data.workItemTitle || !data.requestId) break;
      const folder =
        isMain && data.groupFolder ? data.groupFolder : sourceGroup;
      const newId = createWorkItem({
        group_folder: folder,
        title: data.workItemTitle,
        description: data.workItemDescription ?? null,
        status: 'queued',
        priority: data.workItemPriority ?? 50,
        source: data.workItemSource ?? null,
        started_at: null,
        completed_at: null,
        reasoning: data.workItemReasoning ?? null,
        outcome: null,
        blocked_reason: null,
      });
      logger.info(
        { id: newId, folder, title: data.workItemTitle },
        'Work item created via IPC',
      );
      const wiResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'work_item_responses',
      );
      fs.mkdirSync(wiResponseDir, { recursive: true });
      fs.writeFileSync(
        path.join(wiResponseDir, `${data.requestId}.json`),
        JSON.stringify({ success: true, id: newId }),
      );
      break;
    }

    case 'update_work_item': {
      if (data.workItemId == null || !data.requestId) break;
      const wiUpdateResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'work_item_responses',
      );
      fs.mkdirSync(wiUpdateResponseDir, { recursive: true });

      const updates: Parameters<typeof updateWorkItem>[1] = {};
      if (data.workItemStatus !== undefined)
        updates.status = data.workItemStatus as Parameters<
          typeof updateWorkItem
        >[1]['status'];
      if (data.workItemTitle !== undefined) updates.title = data.workItemTitle;
      if (data.workItemDescription !== undefined)
        updates.description = data.workItemDescription;
      if (data.workItemPriority !== undefined)
        updates.priority = data.workItemPriority;
      if (data.workItemReasoning !== undefined)
        updates.reasoning = data.workItemReasoning;
      if (data.workItemOutcome !== undefined)
        updates.outcome = data.workItemOutcome;
      if (data.workItemBlockedReason !== undefined)
        updates.blocked_reason = data.workItemBlockedReason;

      const result = updateWorkItem(
        data.workItemId,
        updates,
        sourceGroup,
        isMain,
      );
      logger.info(
        { id: data.workItemId, sourceGroup, success: result.success },
        'Work item update via IPC',
      );
      fs.writeFileSync(
        path.join(wiUpdateResponseDir, `${data.requestId}.json`),
        JSON.stringify(result),
      );
      break;
    }

    case 'list_work_items': {
      if (!data.requestId) break;
      const folder = isMain ? (data.groupFolder ?? null) : sourceGroup;
      const items = listWorkItems(folder, data.workItemStatusFilter);
      const wiListResponseDir = path.join(
        DATA_DIR,
        'ipc',
        sourceGroup,
        'work_item_responses',
      );
      fs.mkdirSync(wiListResponseDir, { recursive: true });
      fs.writeFileSync(
        path.join(wiListResponseDir, `${data.requestId}.json`),
        JSON.stringify({ success: true, items }),
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Process an MCP bridge request from a container.
 * Handles both tool calls and tool discovery (list_tools).
 * Forwards to the host-side MCP server and writes the response.
 */
async function processMcpRequest(
  bridge: McpBridge,
  data: {
    requestId: string;
    type?: string;
    server: string;
    tool: string;
    args: Record<string, unknown>;
  },
  responsesDir: string,
  sourceGroup: string,
): Promise<void> {
  fs.mkdirSync(responsesDir, { recursive: true });

  const responseFile = path.join(responsesDir, `${data.requestId}.json`);
  const tempFile = `${responseFile}.tmp`;

  try {
    let result: unknown;

    if (data.type === 'list_tools') {
      // Tool discovery: return all tools from all bridged servers
      result = await bridge.listAllTools();
    } else {
      // Tool call: forward to the specific server
      result = await bridge.callTool(data.server, data.tool, data.args);
    }

    fs.writeFileSync(
      tempFile,
      JSON.stringify({ requestId: data.requestId, result, error: null }),
    );
    fs.renameSync(tempFile, responseFile);
    logger.debug(
      {
        requestId: data.requestId,
        type: data.type || 'call_tool',
        server: data.server,
        tool: data.tool,
        sourceGroup,
      },
      'MCP bridge request completed',
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        requestId: data.requestId,
        result: null,
        error: errorMsg,
      }),
    );
    fs.renameSync(tempFile, responseFile);
    logger.error(
      {
        requestId: data.requestId,
        server: data.server,
        tool: data.tool,
        sourceGroup,
        err,
      },
      'MCP bridge request failed',
    );
  }
}

const MAX_CONCURRENT_AGENT_CALLS = 2;
let activeAgentCalls = 0;

// Restricted groups that cannot be called via cross-agent IPC.
// Set CROSS_AGENT_RESTRICTED_GROUPS env var to a comma-separated list of group folders.
// Main groups are always restricted by default.
function getRestrictedGroups(
  registeredGroups: Record<string, RegisteredGroup>,
): Set<string> {
  const restricted = new Set<string>();
  // Main groups are always restricted
  for (const g of Object.values(registeredGroups)) {
    if (g.isMain) restricted.add(g.folder);
  }
  // Additional restrictions from env
  const envRestricted = process.env.CROSS_AGENT_RESTRICTED_GROUPS;
  if (envRestricted) {
    for (const folder of envRestricted.split(',').map((s) => s.trim())) {
      if (folder) restricted.add(folder);
    }
  }
  return restricted;
}

async function processAgentCallRequest(
  data: {
    requestId: string;
    targetGroup: string;
    prompt: string;
    timeout?: number;
  },
  responsesDir: string,
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  fs.mkdirSync(responsesDir, { recursive: true });

  const responseFile = path.join(responsesDir, `${data.requestId}.json`);
  const tempFile = `${responseFile}.tmp`;

  const writeResponse = (result: string | null, error: string | null) => {
    fs.writeFileSync(
      tempFile,
      JSON.stringify({ requestId: data.requestId, result, error }),
    );
    fs.renameSync(tempFile, responseFile);
  };

  // Validate target group exists
  const targetEntry = Object.entries(registeredGroups).find(
    ([_, g]) => g.folder === data.targetGroup,
  );
  if (!targetEntry) {
    writeResponse(null, `Target group '${data.targetGroup}' not registered`);
    return;
  }

  const [targetJid, targetGroup] = targetEntry;

  // Security: block calls to restricted groups
  const restricted = getRestrictedGroups(registeredGroups);
  if (restricted.has(data.targetGroup)) {
    logger.warn(
      { sourceGroup, targetGroup: data.targetGroup },
      'Cross-agent call to restricted group blocked',
    );
    writeResponse(null, `Calls to '${data.targetGroup}' are not permitted`);
    return;
  }

  // Concurrency guard
  if (activeAgentCalls >= MAX_CONCURRENT_AGENT_CALLS) {
    writeResponse(
      null,
      `Too many concurrent agent calls (max ${MAX_CONCURRENT_AGENT_CALLS}). Try again later.`,
    );
    return;
  }

  activeAgentCalls++;

  logger.info(
    {
      requestId: data.requestId,
      sourceGroup,
      targetGroup: data.targetGroup,
      promptLength: data.prompt.length,
    },
    'Processing cross-agent call',
  );

  // Chat visibility: forward call preview to source group's chat
  const crossAgentVisibility = process.env.CROSS_AGENT_VISIBILITY !== 'false'; // enabled by default
  const sourceEntry = Object.entries(registeredGroups).find(
    ([_, g]) => g.folder === sourceGroup,
  );
  const sourceJid = sourceEntry?.[0];

  if (crossAgentVisibility && sourceJid) {
    const preview =
      data.prompt.length > 500 ? data.prompt.slice(0, 500) + '…' : data.prompt;
    sendMessage(
      sourceJid,
      `[${sourceGroup}] → @${data.targetGroup}\n\n${preview}`,
    ).catch((err) =>
      logger.error({ err, sourceGroup }, 'Failed to forward agent call'),
    );
  }

  try {
    // Track whether we've already written a response (first real result wins)
    let responseWritten = false;

    const output = await runContainerAgent(
      { ...targetGroup, folder: data.targetGroup },
      {
        prompt: `[Cross-agent call from ${sourceGroup}]\n\n${data.prompt}`,
        sessionId: undefined, // isolated — no session reuse
        groupFolder: data.targetGroup,
        chatJid: targetJid,
        isMain: targetGroup.isMain === true,
        isScheduledTask: true,
      },
      () => {
        // No process registration — transient call
      },
      async (streamedOutput) => {
        // Streaming callback: capture the first real result, write response,
        // then signal container to exit via _close sentinel.
        if (streamedOutput.result && !responseWritten) {
          responseWritten = true;

          writeResponse(
            streamedOutput.status === 'success' ? streamedOutput.result : null,
            streamedOutput.status === 'error'
              ? streamedOutput.error || 'Unknown error'
              : null,
          );

          logger.info(
            {
              requestId: data.requestId,
              sourceGroup,
              targetGroup: data.targetGroup,
              status: streamedOutput.status,
              resultLength: streamedOutput.result.length,
            },
            'Cross-agent call: response written (streaming)',
          );

          // Forward the response to the source group's chat for visibility
          if (crossAgentVisibility && sourceJid) {
            const responsePreview =
              streamedOutput.result.length > 500
                ? streamedOutput.result.slice(0, 500) + '…'
                : streamedOutput.result;
            sendMessage(
              sourceJid,
              `@${data.targetGroup} → [${sourceGroup}]\n\n${responsePreview}`,
            ).catch((err) =>
              logger.error(
                { err, sourceGroup },
                'Failed to forward agent call response',
              ),
            );
          }

          // Write _close sentinel to tell the agent-runner to exit
          const inputDir = path.join(
            DATA_DIR,
            'ipc',
            data.targetGroup,
            'input',
          );
          try {
            fs.mkdirSync(inputDir, { recursive: true });
            fs.writeFileSync(path.join(inputDir, '_close'), '');
          } catch {
            // ignore — container will time out eventually
          }
        }
      },
    );

    // Fallback: if streaming never produced a result with text, use final output
    if (!responseWritten) {
      const resultText = output.result || '(no output from agent)';

      writeResponse(
        output.status === 'success' ? resultText : null,
        output.status === 'error' ? output.error || 'Unknown error' : null,
      );

      logger.info(
        {
          requestId: data.requestId,
          sourceGroup,
          targetGroup: data.targetGroup,
          status: output.status,
          resultLength: resultText.length,
        },
        'Cross-agent call completed (fallback)',
      );

      // Forward the response to the source group's chat for visibility
      if (crossAgentVisibility && sourceJid) {
        const responsePreview =
          resultText.length > 500 ? resultText.slice(0, 500) + '…' : resultText;
        sendMessage(
          sourceJid,
          `@${data.targetGroup} → [${sourceGroup}]\n\n${responsePreview}`,
        ).catch((err) =>
          logger.error(
            { err, sourceGroup },
            'Failed to forward agent call response',
          ),
        );
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    writeResponse(null, errorMsg);

    logger.error(
      {
        requestId: data.requestId,
        sourceGroup,
        targetGroup: data.targetGroup,
        err,
      },
      'Cross-agent call failed',
    );
  } finally {
    activeAgentCalls--;
  }
}
