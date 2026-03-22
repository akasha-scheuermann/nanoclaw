---
name: add-plex
description: Add Plex Media Server integration. Runs as an in-container MCP server — no host-side bridge needed.
---

# Add Plex Integration

Adds Plex media tools (search, browse, history, sessions, playlists) to all agent containers.

## Pre-flight

Check if already applied:
```bash
grep -q 'plex-mcp' container/agent-runner/src/index.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
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
PLEX_SERVER_URL=http://192.168.1.100:32400
```

## Phase 3: Build and verify

```bash
npm run build
./container/build.sh
```

## Phase 4: Test

Restart NanoClaw and test from any agent:
- "What's on my Plex server?" — should list libraries
- "Search Plex for Inception" — should find the movie
- "What's currently playing?" — should show active sessions

## What This Adds

- **In-container MCP server** (`plex-mcp.ts`) with Plex REST API tools
- **Tools**: `library_list`, `library_get_contents`, `media_search`, `media_get_details`, `library_get_recently_added`, `sessions_get_active`, `user_get_watch_history`, `user_get_on_deck`, `playlist_list`, `client_list`
- **Env var forwarding** in container-runner for `PLEX_TOKEN` and `PLEX_SERVER_URL`
- **Auto-enabled**: Server starts only when both `PLEX_TOKEN` and `PLEX_SERVER_URL` are set
