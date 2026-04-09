/**
 * iMessage Channel for NanoClaw
 * Uses the `imsg` CLI tool (github.com/steipete/imsg) for iMessage I/O.
 *
 * - Receiving: `imsg watch --json` long-lived subprocess
 * - Sending: `imsg send --chat-id <id> --text <text>` one-shot
 * - JID format: `imsg:<chat_id>` where chat_id is Messages DB ROWID
 *
 * Disabled when IMSG_PATH env var is not set.
 */

import { ChildProcess, spawn, execFile } from 'child_process';
import { createInterface, Interface } from 'readline';

import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';

const DEDUP_WINDOW_MS = 5000;
const DEDUP_CACHE_MAX = 500;
const ECHO_CACHE_MAX = 50;
const ECHO_CACHE_TTL_MS = 30000;
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 300000;
const SEND_TIMEOUT_MS = 15000;

// --- Types matching imsg JSON output ---

interface ImsgWatchMessage {
  id: number; // message ROWID
  guid: string; // globally unique message ID
  chat_id: number; // chat ROWID
  chat_identifier: string; // phone/email or group handle
  chat_guid: string;
  chat_name: string | null;
  is_group: boolean;
  sender: string; // phone/email
  is_from_me: boolean;
  text: string | null;
  created_at: string; // ISO 8601
  reply_to_guid?: string;
  attachments?: Array<{
    filename: string;
    mime_type: string;
    total_bytes: number;
    original_path: string;
  }>;
}

interface ImsgChat {
  id: number; // ROWID
  identifier: string; // phone/email or group handle
  name: string; // display name (empty string if none)
  service: string; // "iMessage" or "SMS"
  is_group?: boolean;
  last_message_at: string; // ISO 8601
}

class IMessageChannel implements Channel {
  name = 'imessage';

  private imsgPath: string;
  private connected = false;
  private watchProcess: ChildProcess | null = null;
  private readline: Interface | null = null;
  private opts: ChannelOpts;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Deduplication: guid -> timestamp
  private seenGuids = new Map<string, number>();

  // Echo suppression: hash of recently sent texts -> timestamp
  private recentSends = new Map<string, number>();

  // Chat metadata cache: chat_id -> chat info
  private chatCache = new Map<number, ImsgChat>();

  constructor(opts: ChannelOpts, imsgPath: string) {
    this.opts = opts;
    this.imsgPath = imsgPath;
  }

  async connect(): Promise<void> {
    await this.verifyImsg();
    await this.syncChatMetadata().catch((err) => {
      logger.warn(
        { err },
        'Initial iMessage chat sync failed, continuing anyway',
      );
    });
    this.startWatch();
    this.connected = true;
    logger.info('iMessage channel connected');
  }

  async sendMessage(
    jid: string,
    text: string,
    _quotedMessageId?: string,
  ): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (chatId === null) {
      throw new Error(`Invalid iMessage JID: ${jid}`);
    }

    return new Promise<void>((resolve, reject) => {
      const args = ['send', '--chat-id', String(chatId), '--text', text];

      execFile(
        this.imsgPath,
        args,
        { timeout: SEND_TIMEOUT_MS },
        (err, stdout, stderr) => {
          if (err) {
            const detail = stderr?.trim() || stdout?.trim() || err.message;
            logger.error(
              { err, stdout: stdout?.trim(), stderr: stderr?.trim(), jid },
              'Failed to send iMessage',
            );
            reject(new Error(`imsg send failed: ${detail}`));
            return;
          }

          // Track sent message for echo suppression
          this.trackSentMessage(text);

          logger.info({ jid, length: text.length }, 'iMessage sent');
          resolve();
        },
      );
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imsg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchProcess) {
      this.watchProcess.kill('SIGTERM');
      this.watchProcess = null;
    }
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    logger.info('iMessage channel disconnected');
  }

  async syncGroups(_force: boolean): Promise<void> {
    await this.syncChatMetadata();
  }

  // Typing indicator — stub (broken on macOS 26)
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // imsg typing is broken on macOS 26 (Tahoe).
    // No-op to avoid errors.
  }

  // --- Private methods ---

  private async verifyImsg(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(
        this.imsgPath,
        ['--version'],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            reject(
              new Error(`imsg not found at ${this.imsgPath}: ${err.message}`),
            );
            return;
          }
          logger.info({ version: stdout.trim() }, 'imsg binary verified');
          resolve();
        },
      );
    });
  }

  private async syncChatMetadata(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      execFile(
        this.imsgPath,
        ['chats', '--json'],
        { timeout: 10000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            logger.error(
              { err, stderr: stderr?.trim() },
              'Failed to sync iMessage chats',
            );
            reject(err);
            return;
          }

          let count = 0;
          for (const line of stdout.trim().split('\n')) {
            if (!line.trim()) continue;
            try {
              const chat: ImsgChat = JSON.parse(line);
              this.chatCache.set(chat.id, chat);
              count++;

              // Notify orchestrator about this chat
              const jid = `imsg:${chat.id}`;
              this.opts.onChatMetadata(
                jid,
                chat.last_message_at || new Date().toISOString(),
                chat.name || chat.identifier,
                'imessage',
                chat.is_group ?? false,
              );
            } catch {
              // skip unparseable lines
            }
          }

          logger.info({ count }, 'iMessage chat metadata synced');
          resolve();
        },
      );
    });
  }

  private startWatch(): void {
    const args = ['watch', '--json'];
    const startedAt = Date.now();
    let stderrBuf = '';

    this.watchProcess = spawn(this.imsgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.readline = createInterface({
      input: this.watchProcess.stdout!,
    });

    this.readline.on('line', (line) => {
      try {
        this.handleWatchLine(line);
      } catch (err) {
        logger.error(
          { err, line: line.slice(0, 200) },
          'Error handling imsg watch line',
        );
      }
    });

    this.watchProcess.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    this.watchProcess.on('exit', (code, signal) => {
      const aliveMs = Date.now() - startedAt;
      const stderr = stderrBuf.trim();
      logger.warn(
        { code, signal, aliveMs, stderr: stderr || undefined },
        'imsg watch exited',
      );
      this.connected = false;
      this.watchProcess = null;
      this.readline = null;
      // Only reset backoff if watch was stable (>30s)
      if (aliveMs > 30_000) {
        this.reconnectAttempt = 0;
      }
      this.scheduleReconnect();
    });

    logger.info('imsg watch started');
  }

  private handleWatchLine(line: string): void {
    if (!line.trim()) return;

    let msg: ImsgWatchMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug({ line: line.slice(0, 100) }, 'Non-JSON watch output');
      return;
    }

    // Skip messages without text
    if (!msg.text) return;

    // Skip own messages
    if (msg.is_from_me) return;

    // Dedup by GUID
    if (msg.guid && this.isDuplicate(msg.guid)) return;

    // Echo suppression — skip if this matches a recently sent message
    if (this.isOwnEcho(msg.text)) return;

    const chatJid = `imsg:${msg.chat_id}`;

    // Notify about chat metadata
    this.opts.onChatMetadata(
      chatJid,
      msg.created_at,
      msg.sender || '',
      'imessage',
      msg.is_group ?? false,
    );

    // Only deliver for registered groups
    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) return;

    // Build sender name
    const senderName = msg.sender || 'Unknown';

    logger.info(
      { chatJid, sender: senderName, text: msg.text.slice(0, 50) },
      'iMessage delivering',
    );

    // Use current time as timestamp so the message is always ahead of the
    // global lastTimestamp cursor (msg.created_at reflects when Messages.app
    // recorded it, which may already be behind the cursor).
    const payload: NewMessage = {
      id: msg.guid || String(msg.id),
      chat_jid: chatJid,
      sender: msg.sender,
      sender_name: senderName,
      content: msg.text,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };
    // Thread reply support (available when thread-replies skill is merged)
    if (msg.reply_to_guid) {
      (payload as unknown as Record<string, unknown>).thread_message_id =
        msg.reply_to_guid;
    }
    this.opts.onMessage(chatJid, payload);
  }

  private isDuplicate(guid: string): boolean {
    const now = Date.now();

    // Clean old entries periodically
    if (this.seenGuids.size > DEDUP_CACHE_MAX) {
      for (const [g, ts] of this.seenGuids) {
        if (now - ts > DEDUP_WINDOW_MS) this.seenGuids.delete(g);
      }
    }

    if (this.seenGuids.has(guid)) return true;
    this.seenGuids.set(guid, now);
    return false;
  }

  private trackSentMessage(text: string): void {
    const hash = this.simpleHash(text);
    this.recentSends.set(hash, Date.now());

    // Clean old entries
    if (this.recentSends.size > ECHO_CACHE_MAX) {
      const now = Date.now();
      for (const [h, ts] of this.recentSends) {
        if (now - ts > ECHO_CACHE_TTL_MS) this.recentSends.delete(h);
      }
    }
  }

  private isOwnEcho(text: string): boolean {
    const hash = this.simpleHash(text);
    const sent = this.recentSends.get(hash);
    if (sent && Date.now() - sent < ECHO_CACHE_TTL_MS) return true;
    return false;
  }

  private simpleHash(text: string): string {
    // Simple hash for echo detection — not cryptographic
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return String(hash);
  }

  private extractChatId(jid: string): number | null {
    if (!jid.startsWith('imsg:')) return null;
    const id = parseInt(jid.slice(5), 10);
    return isNaN(id) ? null : id;
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delayMs = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt - 1),
      RECONNECT_MAX_MS,
    );
    logger.info(
      { attempt: this.reconnectAttempt, delayMs },
      'Reconnecting imsg watch...',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.startWatch();
      this.connected = true;
      // Re-sync chat metadata on reconnect
      this.syncChatMetadata().catch((err) =>
        logger.error({ err }, 'Chat metadata sync failed on reconnect'),
      );
    }, delayMs);
  }
}

// --- Self-registration ---

registerChannel('imessage', (opts: ChannelOpts) => {
  const envConfig = readEnvFile(['IMSG_PATH']);
  const imsgPath = process.env.IMSG_PATH || envConfig.IMSG_PATH;
  if (!imsgPath) {
    // No imsg configured — skip channel silently
    return null;
  }
  return new IMessageChannel(opts, imsgPath);
});
