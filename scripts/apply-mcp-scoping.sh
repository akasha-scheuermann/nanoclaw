#!/bin/bash
# Apply MCP tool scoping to the database
# Run from the NanoClaw root directory
cd "$(dirname "$0")/.." || exit 1
sqlite3 store/messages.db < scripts/apply-mcp-scoping.sql
echo "MCP scoping applied. Verifying:"
sqlite3 store/messages.db "SELECT folder, json_extract(container_config, '$.allowedMcpTools') as mcp FROM registered_groups WHERE json_extract(container_config, '$.allowedMcpTools') IS NOT NULL ORDER BY folder"
