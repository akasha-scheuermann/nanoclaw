---
name: add-imessage
description: Add iMessage as a messaging channel via the imsg CLI tool. macOS only — requires Messages.app and Full Disk Access.
---

# Add iMessage Channel

Adds iMessage as a messaging channel alongside WhatsApp/Telegram. Uses the `imsg` CLI (github.com/steipete/imsg) for reading and sending messages via Messages.app.

## Pre-flight

Check if already applied:
```bash
test -f src/channels/imessage.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

**Requirements:**
- macOS (Messages.app with iCloud sign-in)
- `imsg` CLI binary built and installed
- Full Disk Access granted to `imsg` in System Settings → Privacy

## Phase 1: Apply code changes

Merge the skill branch:
```bash
git fetch origin skill/imessage
git merge origin/skill/imessage
```

If there are merge conflicts:
```bash
git checkout --theirs package-lock.json 2>/dev/null; git add package-lock.json 2>/dev/null
git merge --continue
```

## Phase 2: Build and install imsg

1. Build the imsg binary:
```bash
git clone https://github.com/steipete/imsg /tmp/imsg
cd /tmp/imsg && make build
sudo cp bin/imsg /usr/local/bin/imsg
```

2. Grant Full Disk Access:
   - Open System Settings → Privacy & Security → Full Disk Access
   - Add `/usr/local/bin/imsg`

3. Verify it works:
```bash
imsg chats --json --limit 5
```

## Phase 3: Configure

Add to `.env`:
```
IMSG_PATH=/usr/local/bin/imsg
```

## Phase 4: Build and verify

```bash
npm run build
```

Note: No container rebuild needed — iMessage runs on the host side (like WhatsApp).

## Phase 5: Register a chat

1. Find the chat_id for the iMessage chat you want:
```bash
imsg chats --json | head -20
```

2. Register the group in the database using the `imsg:<chat_id>` JID format.

## Phase 6: Test

Restart NanoClaw and send a message to the registered iMessage chat. The agent should respond.

## What This Adds

- **Channel implementation** (`src/channels/imessage.ts`) following the same pattern as WhatsApp/Telegram
- **Watch subprocess** (`imsg watch --json`) for real-time message reception
- **Send via CLI** (`imsg send --chat-id`) for outbound messages
- **JID format**: `imsg:<chat_id>` where chat_id is the Messages.app database ROWID
- **Deduplication**: GUID cache (5s window) + is_from_me filtering + sent-echo suppression
- **Reconnection**: Exponential backoff (5s → 5min) on watch process exit
- **Auto-enabled**: Channel activates only when `IMSG_PATH` is set in `.env`

## Risks

- `imsg watch` may be unreliable on some macOS versions (15.1+). If it drops messages, consider adding polling fallback with `imsg history --since-rowid`.
- AppleScript sending adds ~1-2s latency per message. Acceptable for personal assistant use.
- Unofficial Messages.app access — Apple could restrict this in future macOS versions.
