#!/bin/bash
#
# migrate-from-fork.sh — Migrate data from old NanoClaw fork to new skill-based fork
#
# Usage: ./scripts/migrate-from-fork.sh /path/to/old/nanoclaw
#
# What it does:
#   1. Copies runtime directories (groups/, data/, shared/, auth creds)
#   2. Migrates SQLite database (handles schema differences between old and new)
#   3. Copies .env (preserving any new-fork additions)
#
# Prerequisites:
#   - NanoClaw must be STOPPED on both old and new
#   - Skill branches should already be merged into new fork's main
#   - npm run build should be run AFTER migration
#
# The old fork has columns (is_main, model, thread_message_id) baked into db.ts.
# The new fork adds these via skill branch migrations (skill/per-group-model,
# skill/thread-replies, skill/cross-agent-calls). If those skills are merged
# before running this script, the columns exist and data transfers cleanly.
# If not, those columns are skipped gracefully.

set -euo pipefail

OLD_DIR="${1:?Usage: $0 /path/to/old/nanoclaw}"
NEW_DIR="$(cd "$(dirname "$0")/.." && pwd)"

OLD_DB="$OLD_DIR/store/messages.db"
NEW_DB="$NEW_DIR/store/messages.db"

if [ ! -f "$OLD_DB" ]; then
  echo "ERROR: Old database not found at $OLD_DB"
  exit 1
fi

echo "=== NanoClaw Fork Migration ==="
echo "Old: $OLD_DIR"
echo "New: $NEW_DIR"
echo ""

# -------------------------------------------------------------------
# Phase 1: Copy runtime directories
# -------------------------------------------------------------------
echo "--- Phase 1: Runtime directories ---"

# groups/ — per-group workspaces (CLAUDE.md, conversations, memory, skills, logs)
if [ -d "$OLD_DIR/groups" ]; then
  echo "Copying groups/..."
  rsync -a --ignore-existing "$OLD_DIR/groups/" "$NEW_DIR/groups/"
  echo "  Done (rsync --ignore-existing preserves new fork's files)"
fi

# data/ — session data, IPC directories
if [ -d "$OLD_DIR/data" ]; then
  echo "Copying data/..."
  rsync -a "$OLD_DIR/data/" "$NEW_DIR/data/"
  echo "  Done"
fi

# shared/ — inter-agent communication
if [ -d "$OLD_DIR/shared" ]; then
  echo "Copying shared/..."
  rsync -a "$OLD_DIR/shared/" "$NEW_DIR/shared/"
  echo "  Done"
fi

# WhatsApp auth credentials
if [ -d "$OLD_DIR/.wwebjs_auth" ]; then
  echo "Copying WhatsApp auth (.wwebjs_auth/)..."
  rsync -a "$OLD_DIR/.wwebjs_auth/" "$NEW_DIR/.wwebjs_auth/"
  echo "  Done"
fi
if [ -d "$OLD_DIR/auth" ]; then
  echo "Copying auth/..."
  rsync -a "$OLD_DIR/auth/" "$NEW_DIR/auth/"
  echo "  Done"
fi

# .env — merge old into new (keep new fork's additions)
if [ -f "$OLD_DIR/.env" ] && [ -f "$NEW_DIR/.env" ]; then
  echo "Merging .env (old values into new, preserving new additions)..."
  # Copy old .env as base, append any new-only keys
  cp "$NEW_DIR/.env" "$NEW_DIR/.env.new-backup"
  cp "$OLD_DIR/.env" "$NEW_DIR/.env"
  # Append keys from new that aren't in old
  while IFS= read -r line; do
    key="${line%%=*}"
    if [ -n "$key" ] && [[ ! "$key" =~ ^# ]] && ! grep -q "^${key}=" "$NEW_DIR/.env" 2>/dev/null; then
      echo "$line" >> "$NEW_DIR/.env"
    fi
  done < "$NEW_DIR/.env.new-backup"
  echo "  Done (backup at .env.new-backup)"
elif [ -f "$OLD_DIR/.env" ]; then
  echo "Copying .env (no existing .env in new fork)..."
  cp "$OLD_DIR/.env" "$NEW_DIR/.env"
  echo "  Done"
fi

echo ""

# -------------------------------------------------------------------
# Phase 2: Database migration
# -------------------------------------------------------------------
echo "--- Phase 2: Database migration ---"

# Back up new DB
cp "$NEW_DB" "$NEW_DB.pre-migration-backup"
echo "Backed up new DB to $NEW_DB.pre-migration-backup"

# Helper: check if column exists in a table
col_exists() {
  local db="$1" table="$2" col="$3"
  sqlite3 "$db" "PRAGMA table_info($table);" | grep -q "|${col}|"
}

# Helper: get column list for a table
get_columns() {
  sqlite3 "$1" "PRAGMA table_info($2);" | cut -d'|' -f2
}

echo ""
echo "Migrating tables..."

# --- chats ---
echo "  chats..."
sqlite3 "$NEW_DB" "DELETE FROM chats;"
sqlite3 "$OLD_DB" ".mode insert chats" ".output /tmp/nc_migrate_chats.sql" "SELECT * FROM chats;"
sqlite3 "$NEW_DB" < /tmp/nc_migrate_chats.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM chats;")
echo "    $COUNT rows"

# --- messages ---
echo "  messages..."
sqlite3 "$NEW_DB" "DELETE FROM messages;"

# Check if both have thread_message_id
if col_exists "$OLD_DB" messages thread_message_id && col_exists "$NEW_DB" messages thread_message_id; then
  echo "    (both have thread_message_id — full copy)"
  sqlite3 "$OLD_DB" ".mode insert messages" ".output /tmp/nc_migrate_messages.sql" "SELECT * FROM messages;"
elif col_exists "$OLD_DB" messages thread_message_id; then
  echo "    (old has thread_message_id, new doesn't — skipping column)"
  # Get new DB's column list and select only those from old
  NEW_COLS=$(get_columns "$NEW_DB" messages | tr '\n' ',' | sed 's/,$//')
  sqlite3 "$OLD_DB" ".mode insert messages" ".output /tmp/nc_migrate_messages.sql" "SELECT $NEW_COLS FROM messages;"
else
  sqlite3 "$OLD_DB" ".mode insert messages" ".output /tmp/nc_migrate_messages.sql" "SELECT * FROM messages;"
fi
sqlite3 "$NEW_DB" < /tmp/nc_migrate_messages.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM messages;")
echo "    $COUNT rows"

# --- registered_groups ---
echo "  registered_groups..."
sqlite3 "$NEW_DB" "DELETE FROM registered_groups;"

# Build column intersection
OLD_RG_COLS=$(get_columns "$OLD_DB" registered_groups)
NEW_RG_COLS=$(get_columns "$NEW_DB" registered_groups)

# Find common columns
COMMON_COLS=""
for col in $NEW_RG_COLS; do
  if echo "$OLD_RG_COLS" | grep -qw "$col"; then
    if [ -z "$COMMON_COLS" ]; then
      COMMON_COLS="$col"
    else
      COMMON_COLS="$COMMON_COLS,$col"
    fi
  fi
done

# Check for columns in old but not in new (will be lost)
for col in $OLD_RG_COLS; do
  if ! echo "$NEW_RG_COLS" | grep -qw "$col"; then
    echo "    WARNING: old has column '$col' not in new — data will be lost unless skill branch adds it"
  fi
done

# Check for columns in new but not in old (will get defaults)
for col in $NEW_RG_COLS; do
  if ! echo "$OLD_RG_COLS" | grep -qw "$col"; then
    echo "    NOTE: new has column '$col' not in old — will use defaults"
  fi
done

sqlite3 "$OLD_DB" ".mode insert registered_groups" ".output /tmp/nc_migrate_rg.sql" "SELECT $COMMON_COLS FROM registered_groups;"
# If we're inserting a subset of columns, we need to specify them
if [ "$COMMON_COLS" != "$(echo "$NEW_RG_COLS" | tr '\n' ',' | sed 's/,$//')" ]; then
  # Rewrite INSERT statements to specify columns
  sed -i.bak "s/INSERT INTO \"registered_groups\" VALUES/INSERT INTO \"registered_groups\" ($COMMON_COLS) VALUES/" /tmp/nc_migrate_rg.sql 2>/dev/null || \
  sed -i '' "s/INSERT INTO \"registered_groups\" VALUES/INSERT INTO \"registered_groups\" ($COMMON_COLS) VALUES/" /tmp/nc_migrate_rg.sql
fi
sqlite3 "$NEW_DB" < /tmp/nc_migrate_rg.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM registered_groups;")
echo "    $COUNT rows"

# --- scheduled_tasks ---
echo "  scheduled_tasks..."
sqlite3 "$NEW_DB" "DELETE FROM scheduled_tasks;"
sqlite3 "$OLD_DB" ".mode insert scheduled_tasks" ".output /tmp/nc_migrate_tasks.sql" "SELECT * FROM scheduled_tasks;"
sqlite3 "$NEW_DB" < /tmp/nc_migrate_tasks.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM scheduled_tasks;")
echo "    $COUNT rows"

# --- task_run_logs ---
echo "  task_run_logs..."
sqlite3 "$NEW_DB" "DELETE FROM task_run_logs;"
sqlite3 "$OLD_DB" ".mode insert task_run_logs" ".output /tmp/nc_migrate_trl.sql" "SELECT * FROM task_run_logs;"
sqlite3 "$NEW_DB" < /tmp/nc_migrate_trl.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM task_run_logs;")
echo "    $COUNT rows"

# --- sessions ---
echo "  sessions..."
sqlite3 "$NEW_DB" "DELETE FROM sessions;"
sqlite3 "$OLD_DB" ".mode insert sessions" ".output /tmp/nc_migrate_sessions.sql" "SELECT * FROM sessions;"
sqlite3 "$NEW_DB" < /tmp/nc_migrate_sessions.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM sessions;")
echo "    $COUNT rows"

# --- router_state ---
echo "  router_state..."
sqlite3 "$NEW_DB" "DELETE FROM router_state;"
sqlite3 "$OLD_DB" ".mode insert router_state" ".output /tmp/nc_migrate_rs.sql" "SELECT * FROM router_state;"
sqlite3 "$NEW_DB" < /tmp/nc_migrate_rs.sql 2>/dev/null || true
COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM router_state;")
echo "    $COUNT rows"

# --- reactions ---
echo "  reactions..."
if sqlite3 "$OLD_DB" "SELECT 1 FROM reactions LIMIT 1;" 2>/dev/null; then
  sqlite3 "$NEW_DB" "DELETE FROM reactions;"
  sqlite3 "$OLD_DB" ".mode insert reactions" ".output /tmp/nc_migrate_reactions.sql" "SELECT * FROM reactions;"
  sqlite3 "$NEW_DB" < /tmp/nc_migrate_reactions.sql 2>/dev/null || true
  COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM reactions;")
  echo "    $COUNT rows"
else
  echo "    (no reactions table in old DB or empty — skipped)"
fi

# Cleanup temp files
rm -f /tmp/nc_migrate_*.sql /tmp/nc_migrate_*.sql.bak

echo ""
echo "--- Phase 3: Verification ---"

echo ""
echo "Old DB row counts:"
for table in chats messages registered_groups scheduled_tasks task_run_logs sessions router_state reactions; do
  COUNT=$(sqlite3 "$OLD_DB" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
  printf "  %-20s %s\n" "$table" "$COUNT"
done

echo ""
echo "New DB row counts:"
for table in chats messages registered_groups scheduled_tasks task_run_logs sessions router_state reactions; do
  COUNT=$(sqlite3 "$NEW_DB" "SELECT COUNT(*) FROM $table;" 2>/dev/null || echo "N/A")
  printf "  %-20s %s\n" "$table" "$COUNT"
done

echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. Review any WARNING messages above"
echo "  2. cd $NEW_DIR && npm run build"
echo "  3. ./container/build.sh"
echo "  4. Start NanoClaw and verify all agents respond"
echo "  5. If issues, restore from $NEW_DB.pre-migration-backup"
