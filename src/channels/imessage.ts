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
import { createInterface } from 'readline';

import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { readEnvFile } from '../env.js';

const envConfig = readEnvFile(['IMSG_PATH']);
const IMSG_PATH = process.env.IMSG_PATH || envConfig.IMSG_PATH || '';

interface ImsgWatchMessage {
  guid: string;
  chat_id: number;
  chat_identifier?: string;
  sender?: string;
  sender_name?: string;
  text?: string;
  date?: string;
  is_from_me?: boolean;
  reply_to_guid?: string;
  service?: string;
}

interface ImsgChat {
  chat_id: number;
  identifier: string;
  display_name?: string;
  is_group?: boolean;
  service?: string;
}

class IMessageChannel implements Channel {
  name = 'imessage';
  private opts: ChannelOpts;
  private imsgPath: string;
  private watchProcess: ChildProcess | null = null;
  private connected = false;

  // Deduplication: GUID cache (5-second window)
  private guidCache = new Map<string, number>();
  private guidCleanupInterval: ReturnType<typeof setInterval> | null = null;

  // Echo suppression: track recently sent texts
  private sentEchoCache = new Map<string, number>();

  // Chat metadata cache: chat_id -> identifier mapping
  private chatIdToIdentifier = new Map<number, string>();

  // Reconnection
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 5000; // Start at 5s, max 5min
  private static readonly MAX_RECONNECT_DELAY = 300000;

  constructor(opts: ChannelOpts, imsgPath: string) {
    this.opts = opts;
    this.imsgPath = imsgPath;
  }

  async connect(): Promise<void> {
    // Verify imsg binary exists
    try {
      await this.execImsg(['--version']);
    } catch (err) {
      logger.error({ error: err }, 'imsg binary not found or not executable');
      throw new Error(`imsg not found at ${this.imsgPath}`);
    }

    // Sync chat metadata
    await this.syncChatMetadata();

    // Start watching for messages
    this.startWatch();

    // Periodically clean up GUID dedup cache
    this.guidCleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5000;
      for (const [guid, ts] of this.guidCache) {
        if (ts < cutoff) this.guidCache.delete(guid);
      }
      // Also clean echo cache (10s window)
      const echoCutoff = Date.now() - 10000;
      for (const [text, ts] of this.sentEchoCache) {
        if (ts < echoCutoff) this.sentEchoCache.delete(text);
      }
    }, 5000);

    this.connected = true;
    logger.info('iMessage channel connected');
  }

  private startWatch(): void {
    const args = ['watch', '--json', '--debounce', '500ms'];
    logger.info({ cmd: this.imsgPath, args }, 'Starting imsg watch');

    const proc = spawn(this.imsgPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.watchProcess = proc;

    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      try {
        this.handleWatchLine(line);
      } catch (err) {
        logger.warn(
          { error: err, line: line.slice(0, 200) },
          'Failed to parse imsg watch line',
        );
      }
    });

    proc.stderr?.on('data', (data) => {
      logger.debug({ imsg: 'stderr' }, data.toString().trim());
    });

    proc.on('close', (code) => {
      logger.warn({ code }, 'imsg watch exited');
      this.watchProcess = null;
      this.scheduleReconnect();
    });

    proc.on('error', (err) => {
      logger.error({ error: err }, 'imsg watch spawn error');
      this.watchProcess = null;
      this.scheduleReconnect();
    });

    // Reset reconnect delay on successful start
    this.reconnectDelay = 5000;
  }

  private handleWatchLine(line: string): void {
    const msg: ImsgWatchMessage = JSON.parse(line);

    // Skip empty messages
    if (!msg.text?.trim()) return;

    // Skip own messages
    if (msg.is_from_me) return;

    // Dedup by GUID (5-second window)
    if (msg.guid && this.guidCache.has(msg.guid)) return;
    if (msg.guid) this.guidCache.set(msg.guid, Date.now());

    const chatJid = `imsg:${msg.chat_id}`;

    // Emit chat metadata
    this.opts.onChatMetadata(
      chatJid,
      msg.date || new Date().toISOString(),
      msg.chat_identifier || `Chat ${msg.chat_id}`,
      'imessage',
      false, // isGroup determined by chat metadata sync
    );

    const newMessage: NewMessage = {
      id:
        msg.guid ||
        `imsg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chat_jid: chatJid,
      sender: msg.sender || msg.chat_identifier || 'unknown',
      sender_name: msg.sender_name || msg.sender || 'Unknown',
      content: msg.text!,
      timestamp: msg.date || new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    this.opts.onMessage(chatJid, newMessage);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    logger.info(
      { delay: this.reconnectDelay },
      'Scheduling imsg watch reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting imsg watch');
      this.startWatch();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      IMessageChannel.MAX_RECONNECT_DELAY,
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/^imsg:/, '');

    // Look up the chat identifier for sending
    const identifier = this.chatIdToIdentifier.get(Number(chatId));

    const args = identifier
      ? ['send', '--chat-identifier', identifier, '--text', text]
      : ['send', '--chat-id', chatId, '--text', text];

    try {
      await this.execImsg(args, 10000);
      // Track for echo suppression
      this.sentEchoCache.set(text.trim(), Date.now());
      logger.debug({ jid, textLen: text.length }, 'iMessage sent');
    } catch (err) {
      logger.error({ jid, error: err }, 'Failed to send iMessage');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected && this.watchProcess !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('imsg:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;

    if (this.guidCleanupInterval) {
      clearInterval(this.guidCleanupInterval);
      this.guidCleanupInterval = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.watchProcess) {
      this.watchProcess.kill('SIGTERM');
      this.watchProcess = null;
    }

    logger.info('iMessage channel disconnected');
  }

  async syncGroups(force: boolean): Promise<void> {
    await this.syncChatMetadata();
  }

  private async syncChatMetadata(): Promise<void> {
    try {
      const output = await this.execImsg(
        ['chats', '--json', '--limit', '100'],
        15000,
      );

      const chats: ImsgChat[] = JSON.parse(output);
      for (const chat of chats) {
        this.chatIdToIdentifier.set(chat.chat_id, chat.identifier);

        const chatJid = `imsg:${chat.chat_id}`;
        this.opts.onChatMetadata(
          chatJid,
          new Date().toISOString(),
          chat.display_name || chat.identifier,
          'imessage',
          chat.is_group || false,
        );
      }

      logger.info({ count: chats.length }, 'Synced iMessage chat metadata');
    } catch (err) {
      logger.warn({ error: err }, 'Failed to sync iMessage chat metadata');
    }
  }

  private execImsg(args: string[], timeout = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.imsgPath, args, { timeout }, (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `imsg ${args[0]} failed: ${err.message}${stderr ? ` (${stderr.trim()})` : ''}`,
            ),
          );
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

// Self-register: factory returns null if IMSG_PATH is not set
registerChannel('imessage', (opts: ChannelOpts) => {
  if (!IMSG_PATH) return null;
  return new IMessageChannel(opts, IMSG_PATH);
});
