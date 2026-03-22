#!/bin/bash
# Reset a group's session and clear pending messages.
# Usage: ./scripts/reset-group.sh <group_folder>
# Example: ./scripts/reset-group.sh whatsapp_entertainment

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DB="$PROJECT_ROOT/store/messages.db"
SESSIONS_DIR="$PROJECT_ROOT/data/sessions"

GROUP="${1:-}"
if [ -z "$GROUP" ]; then
  echo "Usage: $0 <group_folder>"
  echo ""
  echo "Available groups:"
  sqlite3 "$DB" "SELECT group_folder FROM sessions ORDER BY group_folder;" 2>/dev/null | sed 's/^/  /'
  exit 1
fi

echo "Resetting group: $GROUP"

# 1. Stop any running container for this group
CONTAINER=$(docker ps --filter "name=nanoclaw-${GROUP}" -q 2>/dev/null)
if [ -n "$CONTAINER" ]; then
  echo "  Stopping container $CONTAINER..."
  docker stop "$CONTAINER" >/dev/null
else
  echo "  No running container found"
fi

# 2. Delete session from DB
SESSION=$(sqlite3 "$DB" "SELECT session_id FROM sessions WHERE group_folder = '$GROUP';" 2>/dev/null)
if [ -n "$SESSION" ]; then
  echo "  Clearing session $SESSION from DB..."
  sqlite3 "$DB" "DELETE FROM sessions WHERE group_folder = '$GROUP';"

  # 3. Delete session files from disk
  SESSION_DIR="$SESSIONS_DIR/$GROUP/.claude/projects/-workspace-group"
  if [ -d "$SESSION_DIR" ]; then
    COUNT=$(find "$SESSION_DIR" -name "${SESSION}*" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$COUNT" -gt 0 ]; then
      echo "  Removing $COUNT session file(s)..."
      rm -f "$SESSION_DIR/${SESSION}"*
    fi
  fi
else
  echo "  No session found in DB"
fi

# 4. Advance last_timestamp to skip pending messages
echo "  Advancing message timestamp to now..."
sqlite3 "$DB" "UPDATE router_state SET value = datetime('now') WHERE key = 'last_timestamp';"

# 5. Restart nanoclaw
echo "  Restarting nanoclaw..."
launchctl kickstart -k "gui/$(id -u)/com.nanoclaw" 2>/dev/null

echo "Done. Group $GROUP reset. Next message will start a fresh session."
