/**
 * Fastmail MCP Server for NanoClaw
 * Provides email tools via Fastmail's JMAP API.
 * Runs inside the agent container as a child-process MCP server.
 *
 * Required env vars:
 *   FASTMAIL_API_TOKEN  — Fastmail API token (app password with JMAP scope)
 *
 * Optional env vars:
 *   FASTMAIL_ACCOUNT_ID — Fastmail account ID (auto-discovered if omitted)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const JMAP_BASE = 'https://api.fastmail.com';
const JMAP_SESSION_URL = `${JMAP_BASE}/.well-known/jmap`;

const API_TOKEN = process.env.FASTMAIL_API_TOKEN;
if (!API_TOKEN) {
  console.error('[fastmail-mcp] FASTMAIL_API_TOKEN not set, exiting');
  process.exit(1);
}

let accountId = process.env.FASTMAIL_ACCOUNT_ID || '';
let apiUrl = `${JMAP_BASE}/jmap/api`;

interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][];
  sessionState?: string;
}

async function initSession(): Promise<void> {
  if (accountId) return;
  const res = await fetch(JMAP_SESSION_URL, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  if (!res.ok) throw new Error(`JMAP session failed: ${res.status}`);
  const session = (await res.json()) as {
    primaryAccounts: Record<string, string>;
    apiUrl: string;
  };
  accountId =
    session.primaryAccounts['urn:ietf:params:jmap:mail'] ||
    Object.values(session.primaryAccounts)[0];
  if (session.apiUrl) apiUrl = session.apiUrl;
}

async function jmapRequest(
  methodCalls: [string, Record<string, unknown>, string][],
): Promise<JmapResponse> {
  await initSession();
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: JSON.stringify({
      using: [
        'urn:ietf:params:jmap:core',
        'urn:ietf:params:jmap:mail',
        'urn:ietf:params:jmap:submission',
      ],
      methodCalls,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JMAP request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return (await res.json()) as JmapResponse;
}

const server = new McpServer({
  name: 'fastmail',
  version: '1.0.0',
});

// --- List Mailboxes ---
server.tool(
  'list_mailboxes',
  'List all mailboxes (folders) in the email account with unread counts. Start here to discover folders.',
  {},
  async () => {
    const resp = await jmapRequest([
      [
        'Mailbox/get',
        { accountId, properties: ['name', 'role', 'totalEmails', 'unreadEmails', 'parentId'] },
        'mb0',
      ],
    ]);
    const [, result] = resp.methodResponses[0];
    const mailboxes = (result.list as Array<Record<string, unknown>>) || [];
    const formatted = mailboxes.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role || null,
      total: m.totalEmails,
      unread: m.unreadEmails,
      parentId: m.parentId || null,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
  },
);

// --- List Emails ---
server.tool(
  'list_emails',
  'List emails in a specific mailbox/folder. Returns summaries with ID, from, subject, date, and preview.',
  {
    mailbox: z.string().describe("Mailbox name (e.g., 'INBOX', 'Sent', 'Archive') or role (e.g., 'inbox', 'sent', 'drafts', 'trash', 'junk')"),
    limit: z.number().optional().describe('Maximum number of emails to return (default 25, max 100)'),
  },
  async ({ mailbox, limit }) => {
    const maxResults = Math.min(limit || 25, 100);

    // First get mailbox ID by name or role
    const mbResp = await jmapRequest([
      ['Mailbox/get', { accountId, properties: ['name', 'role'] }, 'mb0'],
    ]);
    const [, mbResult] = mbResp.methodResponses[0];
    const mailboxes = (mbResult.list as Array<{ id: string; name: string; role: string | null }>) || [];
    const target = mailboxes.find(
      (m) =>
        m.name.toLowerCase() === mailbox.toLowerCase() ||
        (m.role && m.role.toLowerCase() === mailbox.toLowerCase()),
    );
    if (!target) {
      return { content: [{ type: 'text' as const, text: `Mailbox "${mailbox}" not found. Use list_mailboxes to see available mailboxes.` }] };
    }

    const resp = await jmapRequest([
      [
        'Email/query',
        {
          accountId,
          filter: { inMailbox: target.id },
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: maxResults,
        },
        'eq0',
      ],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'eq0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'from', 'subject', 'receivedAt', 'preview', 'keywords'],
        },
        'eg0',
      ],
    ]);

    const [, emailResult] = resp.methodResponses[1];
    const emails = (emailResult.list as Array<Record<string, unknown>>) || [];
    const formatted = emails.map((e) => ({
      id: e.id,
      from: e.from,
      subject: e.subject,
      date: e.receivedAt,
      preview: typeof e.preview === 'string' ? e.preview.slice(0, 200) : '',
      unread: !(e.keywords as Record<string, boolean> | undefined)?.['$seen'],
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
  },
);

// --- Get Email ---
server.tool(
  'get_email',
  'Get the full content of a specific email by ID. Includes full thread context sorted oldest-first.',
  {
    email_id: z.string().describe('The email ID (from list_emails or search_emails)'),
  },
  async ({ email_id }) => {
    const resp = await jmapRequest([
      [
        'Email/get',
        {
          accountId,
          ids: [email_id],
          properties: [
            'id', 'threadId', 'from', 'to', 'cc', 'bcc', 'replyTo',
            'subject', 'receivedAt', 'textBody', 'htmlBody', 'bodyValues',
            'keywords', 'hasAttachment',
          ],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 50000,
        },
        'eg0',
      ],
    ]);
    const [, result] = resp.methodResponses[0];
    const emails = (result.list as Array<Record<string, unknown>>) || [];
    if (emails.length === 0) {
      return { content: [{ type: 'text' as const, text: `Email ${email_id} not found.` }] };
    }

    const email = emails[0];
    const bodyValues = (email.bodyValues || {}) as Record<string, { value: string }>;
    const textParts = (email.textBody || []) as Array<{ partId: string }>;
    const bodyText = textParts.map((p) => bodyValues[p.partId]?.value || '').join('\n');

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          id: email.id,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          date: email.receivedAt,
          hasAttachment: email.hasAttachment,
          body: bodyText,
        }, null, 2),
      }],
    };
  },
);

// --- Search Emails ---
server.tool(
  'search_emails',
  'Search emails with flexible filters. Supports date ranges, attachment filtering, unread/flagged status.',
  {
    query: z.string().optional().describe('General search — searches subject, body, from, and to'),
    from: z.string().optional().describe('Search sender address/name'),
    to: z.string().optional().describe('Search recipient address/name'),
    subject: z.string().optional().describe('Search subject line only'),
    after: z.string().optional().describe('Emails after this date (YYYY-MM-DD)'),
    before: z.string().optional().describe('Emails before this date (YYYY-MM-DD)'),
    has_attachment: z.boolean().optional().describe('Only emails with attachments'),
    unread: z.boolean().optional().describe('Only unread emails'),
    limit: z.number().optional().describe('Maximum number of results (default 25, max 100)'),
    mailbox: z.string().optional().describe('Limit search to a specific mailbox/folder'),
  },
  async (params) => {
    const maxResults = Math.min(params.limit || 25, 100);
    const filter: Record<string, unknown> = {};

    if (params.query) filter.text = params.query;
    if (params.from) filter.from = params.from;
    if (params.to) filter.to = params.to;
    if (params.subject) filter.subject = params.subject;
    if (params.after) filter.after = `${params.after}T00:00:00Z`;
    if (params.before) filter.before = `${params.before}T23:59:59Z`;
    if (params.has_attachment) filter.hasAttachment = true;
    if (params.unread) filter.hasKeyword = { $not: '$seen' };

    // Resolve mailbox if specified
    if (params.mailbox) {
      const mbResp = await jmapRequest([
        ['Mailbox/get', { accountId, properties: ['name', 'role'] }, 'mb0'],
      ]);
      const [, mbResult] = mbResp.methodResponses[0];
      const mailboxes = (mbResult.list as Array<{ id: string; name: string; role: string | null }>) || [];
      const target = mailboxes.find(
        (m) =>
          m.name.toLowerCase() === params.mailbox!.toLowerCase() ||
          (m.role && m.role.toLowerCase() === params.mailbox!.toLowerCase()),
      );
      if (target) filter.inMailbox = target.id;
    }

    const resp = await jmapRequest([
      [
        'Email/query',
        {
          accountId,
          filter,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: maxResults,
        },
        'eq0',
      ],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'eq0', name: 'Email/query', path: '/ids' },
          properties: ['id', 'from', 'subject', 'receivedAt', 'preview', 'keywords', 'hasAttachment'],
        },
        'eg0',
      ],
    ]);

    const [, emailResult] = resp.methodResponses[1];
    const emails = (emailResult.list as Array<Record<string, unknown>>) || [];
    const formatted = emails.map((e) => ({
      id: e.id,
      from: e.from,
      subject: e.subject,
      date: e.receivedAt,
      preview: typeof e.preview === 'string' ? e.preview.slice(0, 200) : '',
      unread: !(e.keywords as Record<string, boolean> | undefined)?.['$seen'],
      hasAttachment: e.hasAttachment,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
  },
);

// --- Move Email ---
server.tool(
  'move_email',
  'Move an email to a different mailbox/folder.',
  {
    email_id: z.string().describe('The email ID to move'),
    target_mailbox: z.string().describe("Target mailbox name (e.g., 'Archive', 'Trash') or role"),
  },
  async ({ email_id, target_mailbox }) => {
    // Resolve target mailbox
    const mbResp = await jmapRequest([
      ['Mailbox/get', { accountId, properties: ['name', 'role'] }, 'mb0'],
    ]);
    const [, mbResult] = mbResp.methodResponses[0];
    const mailboxes = (mbResult.list as Array<{ id: string; name: string; role: string | null }>) || [];
    const target = mailboxes.find(
      (m) =>
        m.name.toLowerCase() === target_mailbox.toLowerCase() ||
        (m.role && m.role.toLowerCase() === target_mailbox.toLowerCase()),
    );
    if (!target) {
      return { content: [{ type: 'text' as const, text: `Target mailbox "${target_mailbox}" not found.` }] };
    }

    // Get current mailbox(es) for the email
    const emailResp = await jmapRequest([
      ['Email/get', { accountId, ids: [email_id], properties: ['mailboxIds'] }, 'eg0'],
    ]);
    const [, emailResult] = emailResp.methodResponses[0];
    const emails = (emailResult.list as Array<{ mailboxIds: Record<string, boolean> }>) || [];
    if (emails.length === 0) {
      return { content: [{ type: 'text' as const, text: `Email ${email_id} not found.` }] };
    }

    // Build update: remove from all current mailboxes, add to target
    const update: Record<string, unknown> = {};
    for (const mbId of Object.keys(emails[0].mailboxIds)) {
      update[`mailboxIds/${mbId}`] = null;
    }
    update[`mailboxIds/${target.id}`] = true;

    await jmapRequest([
      ['Email/set', { accountId, update: { [email_id]: update } }, 'es0'],
    ]);
    return { content: [{ type: 'text' as const, text: `Email moved to ${target.name}.` }] };
  },
);

// --- Mark Read/Unread ---
server.tool(
  'mark_as_read',
  'Mark an email as read or unread.',
  {
    email_id: z.string().describe('The email ID'),
    read: z.boolean().optional().describe('true to mark read, false to mark unread (default: true)'),
  },
  async ({ email_id, read }) => {
    const markRead = read !== false;
    const update = markRead
      ? { 'keywords/$seen': true }
      : { 'keywords/$seen': null };

    await jmapRequest([
      ['Email/set', { accountId, update: { [email_id]: update } }, 'es0'],
    ]);
    return { content: [{ type: 'text' as const, text: `Email marked as ${markRead ? 'read' : 'unread'}.` }] };
  },
);

// --- Send Email ---
server.tool(
  'send_email',
  'Compose and send an email. IMPORTANT: Always confirm with the user before sending.',
  {
    to: z.array(z.object({
      email: z.string(),
      name: z.string().optional(),
    })).describe('Recipients'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    cc: z.array(z.object({
      email: z.string(),
      name: z.string().optional(),
    })).optional().describe('CC recipients'),
    in_reply_to: z.string().optional().describe('Email ID to reply to (sets threading headers)'),
  },
  async (params) => {
    // Get identity for sending
    const identResp = await jmapRequest([
      ['Identity/get', { accountId }, 'id0'],
    ]);
    const [, identResult] = identResp.methodResponses[0];
    const identities = (identResult.list as Array<{ id: string; email: string }>) || [];
    if (identities.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No sending identity found.' }] };
    }
    const identity = identities[0];

    // Build email
    const email: Record<string, unknown> = {
      from: [{ email: identity.email }],
      to: params.to,
      subject: params.subject,
      bodyValues: { body: { value: params.body } },
      textBody: [{ partId: 'body', type: 'text/plain' }],
    };
    if (params.cc) email.cc = params.cc;

    // If replying, fetch original for threading
    if (params.in_reply_to) {
      const origResp = await jmapRequest([
        ['Email/get', { accountId, ids: [params.in_reply_to], properties: ['messageId', 'references', 'subject', 'threadId'] }, 'eg0'],
      ]);
      const [, origResult] = origResp.methodResponses[0];
      const origEmails = (origResult.list as Array<Record<string, unknown>>) || [];
      if (origEmails.length > 0) {
        const orig = origEmails[0];
        email.inReplyTo = orig.messageId;
        const refs = (orig.references || []) as string[];
        const msgId = (orig.messageId as string[])?.[0];
        email.references = msgId ? [...refs, msgId] : refs;
        email.threadId = orig.threadId;
      }
    }

    // Create draft and submit in one call
    const emailId = 'draft1';
    const resp = await jmapRequest([
      ['Email/set', { accountId, create: { [emailId]: email } }, 'es0'],
      [
        'EmailSubmission/set',
        {
          accountId,
          create: {
            sub1: {
              identityId: identity.id,
              emailId: `#${emailId}`,
            },
          },
          onSuccessDestroyEmail: [`#${emailId}`],
        },
        'ess0',
      ],
    ]);

    const [, subResult] = resp.methodResponses[1];
    if ((subResult as Record<string, unknown>).notCreated) {
      return { content: [{ type: 'text' as const, text: `Failed to send: ${JSON.stringify((subResult as Record<string, unknown>).notCreated)}` }] };
    }

    return { content: [{ type: 'text' as const, text: `Email sent to ${params.to.map((t) => t.email).join(', ')}.` }] };
  },
);

// --- List Attachments ---
server.tool(
  'list_attachments',
  'List all attachments on an email. Returns names, types, sizes, and part IDs.',
  {
    email_id: z.string().describe('The email ID to get attachments from'),
  },
  async ({ email_id }) => {
    const resp = await jmapRequest([
      [
        'Email/get',
        {
          accountId,
          ids: [email_id],
          properties: ['attachments'],
        },
        'eg0',
      ],
    ]);
    const [, result] = resp.methodResponses[0];
    const emails = (result.list as Array<{ attachments?: Array<Record<string, unknown>> }>) || [];
    if (emails.length === 0) {
      return { content: [{ type: 'text' as const, text: `Email ${email_id} not found.` }] };
    }

    const attachments = emails[0].attachments || [];
    const formatted = attachments.map((a) => ({
      name: a.name || 'unnamed',
      type: a.type,
      size: a.size,
      blobId: a.blobId,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }] };
  },
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
