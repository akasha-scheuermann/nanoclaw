/**
 * Plex MCP Server for NanoClaw
 * Provides media tools via Plex Media Server REST API.
 * Runs inside the agent container as a child-process MCP server.
 *
 * Required env vars:
 *   PLEX_TOKEN      — Plex authentication token
 *   PLEX_SERVER_URL — Plex server URL (e.g., http://192.168.1.100:32400)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PLEX_TOKEN = process.env.PLEX_TOKEN;
const PLEX_SERVER_URL = (process.env.PLEX_SERVER_URL || '').replace(/\/$/, '');

if (!PLEX_TOKEN || !PLEX_SERVER_URL) {
  console.error('[plex-mcp] PLEX_TOKEN and PLEX_SERVER_URL must be set, exiting');
  process.exit(1);
}

const HEADERS = {
  'X-Plex-Token': PLEX_TOKEN,
  Accept: 'application/json',
};

async function plexGet(endpoint: string): Promise<unknown> {
  const res = await fetch(`${PLEX_SERVER_URL}${endpoint}`, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Plex API error (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
}

function formatSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${mins}m`;
}

const server = new McpServer({
  name: 'plex',
  version: '1.0.0',
});

// --- List Libraries ---
server.tool(
  'library_list',
  'List all available libraries on the Plex server.',
  {},
  async () => {
    const data = (await plexGet('/library/sections')) as {
      MediaContainer: { Directory: Array<Record<string, unknown>> };
    };
    const libs = data.MediaContainer.Directory.map((d) => ({
      key: d.key,
      title: d.title,
      type: d.type,
      count: d.count || 0,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(libs, null, 2) }] };
  },
);

// --- Library Contents ---
server.tool(
  'library_get_contents',
  'Get filtered and paginated contents of a Plex library.',
  {
    library_name: z.string().describe('Name of the library'),
    limit: z.number().optional().describe('Maximum items to return (default: 50)'),
    offset: z.number().optional().describe('Number of items to skip'),
    sort: z.string().optional().describe('Sort order (e.g., addedAt:desc, titleSort:asc)'),
    unwatched: z.boolean().optional().describe('Return only unwatched items'),
    year: z.number().optional().describe('Filter by release year'),
    genre: z.string().optional().describe('Filter by genre'),
  },
  async (params) => {
    // Find library key by name
    const sections = (await plexGet('/library/sections')) as {
      MediaContainer: { Directory: Array<{ key: string; title: string }> };
    };
    const lib = sections.MediaContainer.Directory.find(
      (d) => d.title.toLowerCase() === params.library_name.toLowerCase(),
    );
    if (!lib) {
      return { content: [{ type: 'text' as const, text: `Library "${params.library_name}" not found.` }] };
    }

    let endpoint = `/library/sections/${lib.key}/all?`;
    const qs: string[] = [];
    if (params.limit) qs.push(`X-Plex-Container-Size=${params.limit}`);
    if (params.offset) qs.push(`X-Plex-Container-Start=${params.offset}`);
    if (params.sort) qs.push(`sort=${params.sort}`);
    if (params.unwatched) qs.push('unwatched=1');
    if (params.year) qs.push(`year=${params.year}`);
    if (params.genre) qs.push(`genre=${params.genre}`);
    endpoint += qs.join('&');

    const data = (await plexGet(endpoint)) as {
      MediaContainer: { Metadata: Array<Record<string, unknown>> };
    };
    const items = (data.MediaContainer.Metadata || []).map((m) => ({
      ratingKey: m.ratingKey,
      title: m.title,
      year: m.year,
      type: m.type,
      rating: m.rating,
      addedAt: m.addedAt ? new Date(Number(m.addedAt) * 1000).toISOString() : null,
      viewCount: m.viewCount || 0,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
  },
);

// --- Search Media ---
server.tool(
  'media_search',
  'Search for media across all Plex libraries.',
  {
    query: z.string().describe('Search term'),
    content_type: z.string().optional().describe('Content type: movie, show, episode, track, album, artist'),
  },
  async ({ query, content_type }) => {
    let endpoint = `/hubs/search?query=${encodeURIComponent(query)}&limit=25`;
    if (content_type) {
      const typeMap: Record<string, number> = {
        movie: 1, show: 2, season: 3, episode: 4,
        artist: 8, album: 9, track: 10,
      };
      if (typeMap[content_type]) endpoint += `&type=${typeMap[content_type]}`;
    }

    const data = (await plexGet(endpoint)) as {
      MediaContainer: { Hub: Array<{ type: string; Metadata?: Array<Record<string, unknown>> }> };
    };
    const results: Array<Record<string, unknown>> = [];
    for (const hub of data.MediaContainer.Hub || []) {
      for (const m of hub.Metadata || []) {
        results.push({
          ratingKey: m.ratingKey,
          title: m.title,
          type: m.type,
          year: m.year,
          parentTitle: m.parentTitle || null,
          grandparentTitle: m.grandparentTitle || null,
        });
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  },
);

// --- Get Media Details ---
server.tool(
  'media_get_details',
  'Get detailed information about a specific media item.',
  {
    media_id: z.number().describe('Plex media ID/rating key'),
  },
  async ({ media_id }) => {
    const data = (await plexGet(`/library/metadata/${media_id}`)) as {
      MediaContainer: { Metadata: Array<Record<string, unknown>> };
    };
    const items = data.MediaContainer.Metadata || [];
    if (items.length === 0) {
      return { content: [{ type: 'text' as const, text: `Media ${media_id} not found.` }] };
    }

    const m = items[0];
    const media = (m.Media as Array<Record<string, unknown>>) || [];
    const result: Record<string, unknown> = {
      ratingKey: m.ratingKey,
      title: m.title,
      type: m.type,
      year: m.year,
      summary: m.summary,
      rating: m.rating,
      audienceRating: m.audienceRating,
      contentRating: m.contentRating,
      duration: m.duration ? formatDuration(Number(m.duration)) : null,
      genres: ((m.Genre as Array<{ tag: string }>) || []).map((g) => g.tag),
      roles: ((m.Role as Array<{ tag: string }>) || []).slice(0, 5).map((r) => r.tag),
      viewCount: m.viewCount || 0,
      addedAt: m.addedAt ? new Date(Number(m.addedAt) * 1000).toISOString() : null,
    };
    if (media.length > 0) {
      const f = media[0];
      result.resolution = f.videoResolution;
      result.videoCodec = f.videoCodec;
      result.audioCodec = f.audioCodec;
      const parts = (f.Part as Array<{ size?: number; file?: string }>) || [];
      if (parts.length > 0) {
        result.fileSize = parts[0].size ? formatSize(Number(parts[0].size)) : null;
        result.filePath = parts[0].file;
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  },
);

// --- Recently Added ---
server.tool(
  'library_get_recently_added',
  'Get recently added media across all libraries or a specific library.',
  {
    library_name: z.string().optional().describe('Library to limit results to'),
    count: z.number().optional().describe('Number of items to return (default: 50)'),
  },
  async (params) => {
    let endpoint = `/library/recentlyAdded?X-Plex-Container-Size=${params.count || 50}`;

    if (params.library_name) {
      const sections = (await plexGet('/library/sections')) as {
        MediaContainer: { Directory: Array<{ key: string; title: string }> };
      };
      const lib = sections.MediaContainer.Directory.find(
        (d) => d.title.toLowerCase() === params.library_name!.toLowerCase(),
      );
      if (lib) endpoint = `/library/sections/${lib.key}/recentlyAdded?X-Plex-Container-Size=${params.count || 50}`;
    }

    const data = (await plexGet(endpoint)) as {
      MediaContainer: { Metadata: Array<Record<string, unknown>> };
    };
    const items = (data.MediaContainer.Metadata || []).map((m) => ({
      ratingKey: m.ratingKey,
      title: m.title,
      type: m.type,
      year: m.year,
      addedAt: m.addedAt ? new Date(Number(m.addedAt) * 1000).toISOString() : null,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
  },
);

// --- Active Sessions ---
server.tool(
  'sessions_get_active',
  'Get information about current playback sessions.',
  {},
  async () => {
    const data = (await plexGet('/status/sessions')) as {
      MediaContainer: { Metadata?: Array<Record<string, unknown>> };
    };
    const sessions = (data.MediaContainer.Metadata || []).map((s) => ({
      title: s.title,
      type: s.type,
      player: (s.Player as Record<string, unknown>)?.title,
      user: (s.User as Record<string, unknown>)?.title,
      state: (s.Player as Record<string, unknown>)?.state,
      progress: s.viewOffset && s.duration
        ? `${Math.round((Number(s.viewOffset) / Number(s.duration)) * 100)}%`
        : null,
    }));
    return { content: [{ type: 'text' as const, text: sessions.length > 0 ? JSON.stringify(sessions, null, 2) : 'No active sessions.' }] };
  },
);

// --- Watch History ---
server.tool(
  'user_get_watch_history',
  'Get recent watch history.',
  {
    limit: z.number().optional().describe('Maximum items to return'),
    content_type: z.string().optional().describe('Filter by type: movie, show, episode'),
  },
  async (params) => {
    let endpoint = `/status/sessions/history/all?sort=viewedAt:desc`;
    if (params.limit) endpoint += `&X-Plex-Container-Size=${params.limit}`;
    const typeMap: Record<string, number> = { movie: 1, show: 2, episode: 4 };
    if (params.content_type && typeMap[params.content_type]) {
      endpoint += `&type=${typeMap[params.content_type]}`;
    }

    const data = (await plexGet(endpoint)) as {
      MediaContainer: { Metadata?: Array<Record<string, unknown>> };
    };
    const items = (data.MediaContainer.Metadata || []).map((m) => ({
      title: m.title,
      type: m.type,
      parentTitle: m.parentTitle || null,
      grandparentTitle: m.grandparentTitle || null,
      viewedAt: m.viewedAt ? new Date(Number(m.viewedAt) * 1000).toISOString() : null,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(items, null, 2) }] };
  },
);

// --- On Deck ---
server.tool(
  'user_get_on_deck',
  'Get in-progress media items (next episodes and partially-watched content).',
  {},
  async () => {
    const data = (await plexGet('/library/onDeck')) as {
      MediaContainer: { Metadata?: Array<Record<string, unknown>> };
    };
    const items = (data.MediaContainer.Metadata || []).map((m) => ({
      ratingKey: m.ratingKey,
      title: m.title,
      type: m.type,
      parentTitle: m.parentTitle || null,
      grandparentTitle: m.grandparentTitle || null,
      progress: m.viewOffset && m.duration
        ? `${Math.round((Number(m.viewOffset) / Number(m.duration)) * 100)}%`
        : null,
    }));
    return { content: [{ type: 'text' as const, text: items.length > 0 ? JSON.stringify(items, null, 2) : 'Nothing on deck.' }] };
  },
);

// --- Playlists ---
server.tool(
  'playlist_list',
  'List all playlists on the Plex server.',
  {
    content_type: z.string().optional().describe('Filter by type: audio, video, photo'),
  },
  async (params) => {
    let endpoint = '/playlists';
    if (params.content_type) endpoint += `?playlistType=${params.content_type}`;

    const data = (await plexGet(endpoint)) as {
      MediaContainer: { Metadata?: Array<Record<string, unknown>> };
    };
    const playlists = (data.MediaContainer.Metadata || []).map((p) => ({
      ratingKey: p.ratingKey,
      title: p.title,
      type: p.playlistType,
      itemCount: p.leafCount,
      duration: p.duration ? formatDuration(Number(p.duration)) : null,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(playlists, null, 2) }] };
  },
);

// --- Client List ---
server.tool(
  'client_list',
  'List all available Plex clients including idle players.',
  {},
  async () => {
    const data = (await plexGet('/clients')) as {
      MediaContainer: { Server?: Array<Record<string, unknown>> };
    };
    const clients = (data.MediaContainer.Server || []).map((c) => ({
      name: c.name,
      host: c.host,
      product: c.product,
      machineIdentifier: c.machineIdentifier,
      protocolCapabilities: c.protocolCapabilities,
    }));
    return { content: [{ type: 'text' as const, text: clients.length > 0 ? JSON.stringify(clients, null, 2) : 'No clients found.' }] };
  },
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
