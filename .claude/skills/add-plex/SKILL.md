---
name: add-plex
description: Add Plex Media Server integration using plex-mcp-server (Python, via uvx). Runs as an in-container MCP server — no host-side bridge needed.
---

# Add Plex Integration

Adds Plex media tools to all agent containers using the community `plex-mcp-server` PyPI package (via `uvx`).

## Pre-flight

Check if already applied:
```bash
grep -q 'plex-mcp-server' container/agent-runner/src/index.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Phase 1: Apply code changes

Merge the skill branch:
```bash
git fetch origin skill/plex
git merge origin/skill/plex
```

If there are merge conflicts:
```bash
git checkout --theirs package-lock.json 2>/dev/null; git add package-lock.json 2>/dev/null
git merge --continue
```

## Phase 2: Configure credentials

1. Ask the user for their Plex token:
   - Visit https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/
   - Or inspect any Plex web request for `X-Plex-Token` parameter

2. Ask for Plex server URL (e.g., `http://192.168.1.100:32400`)

3. Add to `.env`:
```
PLEX_TOKEN=your-plex-token
PLEX_URL=http://192.168.1.100:32400
```

## Phase 3: Build and verify

```bash
npm run build
./container/build.sh    # Rebuilds container with uv for Python MCP servers
```

## Phase 4: Test

Restart NanoClaw and test from any agent:
- "What's on my Plex server?" — should list libraries
- "Search Plex for Inception" — should find the movie
- "What's currently playing?" — should show active sessions

## What This Adds

- **`uv` in Dockerfile** — Python package runner for MCP servers that use PyPI
- **MCP server config** in `container/agent-runner/src/index.ts` — spawns `uvx plex-mcp-server --transport stdio` with credentials as CLI args
- **Env var forwarding** for `PLEX_TOKEN` and `PLEX_URL`
- **Auto-enabled**: Server starts only when both `PLEX_TOKEN` and `PLEX_URL` are set

### Tools provided by `plex-mcp-server`

Libraries, media search, playback control, sessions, history, playlists, collections, and user management — full Plex API coverage with OAuth 2.1 support.
