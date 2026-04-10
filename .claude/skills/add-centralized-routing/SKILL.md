---
name: add-centralized-routing
description: Add centralized agent routing with one front-door agent that routes queries to domain agents via hierarchical swarm. Includes capability manifests, intent routing, parallel fan-out via Teams SDK, and response synthesis.
---

# Add Centralized Agent Routing

One front-door agent handles all domains via hierarchical swarm routing. The orchestrator maintains the conversation thread; domain agents are parallel workers that report back.

## Pre-flight

Check if already applied:
```bash
[ -f shared/agent-registry.json ] && echo "ALREADY APPLIED" || echo "NOT APPLIED"
```

If already applied, tell the user and stop.

## Prerequisites

These must already be in place:
- `call_agent` IPC (check: `grep -q 'call_agent' container/agent-runner/src/ipc-mcp-stdio.ts`)
- Teams SDK enabled (check: `grep -q 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS' container/agent-runner/Dockerfile`)
- Shared directory skill (check: `[ -d shared/ ]`)

If any are missing, tell the user to apply those skills first.

---

## Phase 1: Agent Capability Manifests

Create the registry that enables routing decisions.

### 1.1 Manifest schema

The schema is included in this skill directory: `agent-registry.schema.json`

Copy it to your shared directory:
```bash
cp .claude/skills/add-centralized-routing/agent-registry.schema.json shared/
```

Schema structure:
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "agents": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["folder", "name", "domains", "can_answer", "cannot_answer"],
        "properties": {
          "folder": {
            "type": "string",
            "description": "Group folder name (e.g., whatsapp_fitness)"
          },
          "name": {
            "type": "string",
            "description": "Human-readable agent name (e.g., #fitness)"
          },
          "domains": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Topic domains this agent covers"
          },
          "data_access": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Vault Focus Areas and data sources accessible"
          },
          "can_answer": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Example queries this agent handles well"
          },
          "cannot_answer": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Query types that should NOT route here"
          },
          "latency_tier": {
            "type": "string",
            "enum": ["fast", "medium", "slow"],
            "description": "Expected response time: fast (<5s), medium (<30s), slow (>30s)"
          },
          "tools": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Special tools/MCP servers this agent has access to"
          }
        }
      }
    }
  }
}
```

### 1.2 Create initial registry

Create the registry in `groups/global/agent-registry.json` (gitignored — contains your domain-specific data).

An example template is included: `agent-registry.example.json`

For each registered agent, read their CLAUDE.md to extract capabilities:

1. Read `groups/{folder}/CLAUDE.md`
2. Extract: domains from "## Role", data access from "## Container Mounts", capabilities from "## Domain-Specific Capabilities"
3. Synthesize `can_answer` examples from the agent's documented responsibilities
4. Synthesize `cannot_answer` from "## What You Don't Do" or by inferring boundaries

Start with the 5 highest-traffic agents:
- `whatsapp_system` (#system)
- `whatsapp_planning` (#system-planning)
- `whatsapp_fitness` (#fitness)
- `whatsapp_finance` (#finance)
- `whatsapp_main` (Ryan's DM — general queries)

### 1.3 Validation script

Create `scripts/validate-agent-registry.ts`:
- Load schema and registry
- Validate all entries against schema
- Check that all `folder` values exist in `groups/`
- Warn on overlapping domains (may be intentional)

Run: `npx tsx scripts/validate-agent-registry.ts`

---

## Phase 2: Intent Routing Layer

Build the routing logic that maps utterances to agents.

### 2.1 Create routing prompt

Create `shared/routing-prompt.md` — a system prompt for the orchestrator:

```markdown
You are a routing orchestrator. Given a user query and the agent registry, determine which agent(s) should handle it.

## Agent Registry
{{AGENT_REGISTRY}}

## Routing Rules

1. **Single-agent queries**: Most queries map to exactly one domain. Route directly.
2. **Multi-agent queries**: Some queries span domains (e.g., "What's my workout today and do I have any conflicts on my calendar?"). Fan out to each relevant agent with a targeted sub-question.
3. **Ambiguous queries**: If the intent is unclear, ask the user for clarification rather than guessing.
4. **Fallback**: If no domain agent matches, the orchestrator handles it directly.

## Output Format

Return JSON:
```json
{
  "routing": "single" | "multi" | "clarify" | "self",
  "targets": [
    {
      "folder": "whatsapp_fitness",
      "sub_question": "What is Ryan's workout scheduled for today?"
    }
  ],
  "clarification_prompt": "Did you mean X or Y?" // only if routing=clarify
}
```

## Important

- Route the targeted sub-question, NOT the raw user utterance
- Include relevant context from conversation history in each sub-question
- If a query is simple and doesn't need domain expertise, handle it yourself (routing=self)
```

### 2.2 Implement router in orchestrator

The front-door agent's CLAUDE.md will include:
1. Load `shared/agent-registry.json` on startup
2. For each incoming message, run the routing prompt
3. Execute the routing decision (call agents or respond directly)

This logic lives in the agent's CLAUDE.md instructions, not in TypeScript — the agent uses its existing tools (`call_agent` or Teams) to execute.

---

## Phase 3: Parallel Fan-out via Teams

Switch from `call_agent` (2-concurrent cap) to Teams SDK for multi-agent calls.

### 3.1 Teams-based fan-out

When `routing=multi`, the orchestrator:
1. Creates a team with `TeamCreate` (name based on query hash)
2. Spawns parallel subagents via `Agent` tool with `subagent_type: "domain-worker"`
3. Each subagent receives: the sub-question, last N conversation turns for context, and instructions to return a focused answer
4. Orchestrator waits for all subagents (or timeout)

### 3.2 Context propagation

Each domain agent call includes:
- The targeted sub-question (from routing)
- Last 5 conversation turns (for context)
- The user's name and any relevant preferences

Create `shared/context-template.md`:
```markdown
## Context
User: {{USER_NAME}}
Recent conversation:
{{LAST_N_TURNS}}

## Your Task
{{SUB_QUESTION}}

## Instructions
- Answer ONLY the question above
- Be concise — this will be synthesized with other agent responses
- If you cannot answer, say so clearly
- Do not ask clarifying questions — work with what you have
```

### 3.3 Timeout handling

If an agent exceeds 30 seconds:
- Proceed without it
- Note in synthesis: "Note: [Agent] response timed out"
- Log the timeout for debugging

---

## Phase 4: Response Synthesis

Combine domain agent responses into a coherent reply.

### 4.1 Synthesis prompt

Create `shared/synthesis-prompt.md`:

```markdown
You received responses from multiple domain agents. Synthesize them into a single, coherent response for the user.

## Agent Responses
{{AGENT_RESPONSES}}

## Synthesis Rules

1. **Merge, don't list**: Combine information naturally. Don't say "According to #fitness... According to #calendar..."
2. **Resolve conflicts**: If agents contradict, surface both perspectives: "Your workout is scheduled for 6pm, though your calendar shows a 6pm meeting — you may want to adjust one."
3. **Preserve voice**: Match the user's conversational style (casual, direct)
4. **Handle gaps**: If an agent timed out or couldn't answer, note it briefly
5. **Attribution (internal)**: Track which agent contributed what (for logging), but don't expose this to the user unless relevant

## Output

The synthesized response to send to the user. No JSON wrapper — just the natural language response.
```

### 4.2 Surface-specific formatting

For different output surfaces:
- **Chat (WhatsApp/iMessage)**: Structured with line breaks, can use formatting
- **Voice (future)**: 2-3 sentences max, spoken cadence, no bullet points
- **Dashboard (future)**: Data-focused, can include tables/charts

The synthesis prompt can take a `surface` parameter to adjust output style.

---

## Phase 5: Front-Door Agent Setup

Create and configure the orchestrator agent.

### 5.1 Create orchestrator group

```bash
# Create group folder
mkdir -p groups/whatsapp_orchestrator

# Register in database
sqlite3 store/messages.db "INSERT INTO registered_groups (jid, folder, name, is_main) VALUES ('ORCHESTRATOR_JID', 'whatsapp_orchestrator', 'Orchestrator', 0);"
```

Replace `ORCHESTRATOR_JID` with the actual WhatsApp group JID (create a new group for this).

### 5.2 Write orchestrator CLAUDE.md

Create `groups/whatsapp_orchestrator/CLAUDE.md` with:
- Role: "You are the front-door orchestrator for all Akasha agents"
- Load `shared/agent-registry.json` and routing/synthesis prompts
- Use Teams SDK for parallel domain calls
- Maintain conversation context across turns
- Handle direct queries when no routing needed

### 5.3 Migration plan

Phase in gradually:
1. **Pilot**: Route 10% of queries through orchestrator, rest direct to domain groups
2. **Expand**: Increase to 50%, monitor latency and accuracy
3. **Default**: Make orchestrator the primary entry point
4. **Preserve direct access**: Keep domain groups active for deep-dive conversations

---

## Verification

After applying:

1. **Registry validation**: `npx tsx scripts/validate-agent-registry.ts` passes
2. **Single-agent routing**: Query "What's my workout today?" routes to #fitness
3. **Multi-agent routing**: Query "What's my workout and any calendar conflicts?" fans out to #fitness + #calendar
4. **Synthesis**: Multi-agent responses are merged coherently
5. **Timeout handling**: Slow agent doesn't block the response

---

## What This Adds

**In skill directory (tracked in repo):**
- `agent-registry.schema.json` — manifest schema (copy to shared/)
- `agent-registry.example.json` — example registry with placeholder data

**In shared/ (gitignored runtime content):**
- `agent-registry.schema.json` — copied from skill
- `routing-prompt.md` — intent routing instructions
- `context-template.md` — context propagation template
- `synthesis-prompt.md` — response synthesis instructions

**In groups/global/ (gitignored userland):**
- `agent-registry.json` — YOUR capability registry (domain-specific)

**In scripts/:**
- `validate-agent-registry.ts` — registry validation

**In groups/:**
- `whatsapp_orchestrator/` — front-door agent configuration

## Dependencies

- `call_agent` IPC (for single-agent routes)
- Teams SDK (for multi-agent fan-out)
- Shared directory (for registry and prompts)
