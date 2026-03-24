/**
 * log-pruner.ts — Container log retention
 *
 * Prunes per-group container log files older than KEEP_DAYS.
 * Runs at startup and then every 24 hours.
 *
 * Default: keep last 7 days. Override with LOG_RETENTION_DAYS env var.
 */

import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const KEEP_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? '7', 10);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prune log files older than KEEP_DAYS across all group log directories.
 * @param groupsDir  Path to the groups/ directory (e.g. /path/to/nanoclaw/groups)
 */
export function pruneContainerLogs(groupsDir: string): void {
  if (!fs.existsSync(groupsDir)) return;

  const cutoff = Date.now() - KEEP_DAYS * MS_PER_DAY;
  let totalDeleted = 0;
  let totalKept = 0;

  for (const groupName of fs.readdirSync(groupsDir)) {
    const logsDir = path.join(groupsDir, groupName, 'logs');
    if (!fs.existsSync(logsDir)) continue;

    for (const file of fs.readdirSync(logsDir)) {
      if (!file.startsWith('container-') || !file.endsWith('.log')) continue;

      const filePath = path.join(logsDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          totalDeleted++;
        } else {
          totalKept++;
        }
      } catch (err) {
        logger.warn(
          { filePath, err },
          'log-pruner: failed to stat/delete file',
        );
      }
    }
  }

  if (totalDeleted > 0) {
    logger.info(
      { totalDeleted, totalKept, keepDays: KEEP_DAYS },
      'log-pruner: pruned container logs',
    );
  }
}

/**
 * Start the log pruner: run once immediately, then every 24 hours.
 * @param groupsDir  Path to the groups/ directory
 */
export function startLogPruner(groupsDir: string): void {
  pruneContainerLogs(groupsDir);
  setInterval(() => pruneContainerLogs(groupsDir), MS_PER_DAY);
}
