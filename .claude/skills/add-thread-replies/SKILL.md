---
name: add-thread-replies
description: WhatsApp thread reply detection. Captures thread_message_id from contextInfo for threaded conversation support.
---

# Add Thread Replies

Detects WhatsApp thread replies (quoted messages) and stores the referenced message ID. Enables agents to understand conversation threading context.

## Pre-flight

Check if already applied:
```bash
grep -q 'thread_message_id' src/types.ts && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Dependencies

Requires `skill/whatsapp` (WhatsApp channel).

## Phase 1: Apply code changes

```bash
git fetch origin skill/thread-replies
git merge origin/skill/thread-replies
```

## Phase 2: Build and verify

```bash
npm run build
```

## What This Adds

- `thread_message_id` field on `NewMessage` type
- DB migration: `thread_message_id` column on `messages` table
- WhatsApp channel: extracts `stanzaId` from `contextInfo` on quoted messages
- Stored in DB for future use (threaded replies, context awareness)
