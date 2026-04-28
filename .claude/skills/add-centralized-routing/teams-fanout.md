# Teams Fan-out Guide

The orchestrator uses Claude Agent SDK Teams for parallel domain agent calls. This provides unlimited concurrency (vs `call_agent`'s 2-concurrent cap).

## When to Use Each

| Method | Use When | Concurrency |
|--------|----------|-------------|
| `call_agent` IPC | Single-agent routing, simple queries | Max 2 concurrent |
| Teams SDK | Multi-agent fan-out, complex queries | Unlimited |
| Direct response | Self-handled queries | N/A |

## Teams SDK Usage

### Creating a Team for Fan-out

```javascript
// The orchestrator spawns parallel agents for multi-domain queries
const routingResult = {
  routing: "multi",
  targets: [
    { folder: "whatsapp_fitness", sub_question: "What's today's workout?" },
    { folder: "whatsapp_system-planning", sub_question: "Any calendar conflicts?" }
  ]
};

// Spawn agents in parallel using the Agent tool
for (const target of routingResult.targets) {
  Agent({
    description: `Query ${target.name}`,
    prompt: buildContextPrompt(target.sub_question, conversationHistory),
    subagent_type: "domain-worker",
    run_in_background: false  // Wait for response
  });
}
```

### Parallel Execution Pattern

For multi-agent routing, the orchestrator should:

1. **Parse the routing decision** — identify all target agents
2. **Build context prompts** — apply context-template.md for each
3. **Spawn agents in parallel** — use multiple Agent tool calls in ONE message
4. **Collect responses** — wait for all (or timeout)
5. **Synthesize** — apply synthesis-prompt.md to merge responses

### Example Orchestrator Flow

```
User: "What's my workout today and any calendar conflicts?"

1. ROUTING DECISION:
   {
     "routing": "multi",
     "targets": [
       { "folder": "whatsapp_fitness", "sub_question": "What workout is scheduled for today?" },
       { "folder": "whatsapp_system-planning", "sub_question": "What calendar events might conflict with a morning workout?" }
     ]
   }

2. PARALLEL AGENT CALLS (single message with multiple tool uses):
   <Agent description="Query #fitness" prompt="[context + sub_question]" />
   <Agent description="Query #system-planning" prompt="[context + sub_question]" />

3. COLLECT RESPONSES:
   #fitness: "Tuesday strength session - Planche/Lever + False Grip"
   #system-planning: "10am Process Street sync, 2pm dentist"

4. SYNTHESIZE:
   "Your workout today is Planche/Lever + False Grip (Tuesday strength).
    Heads up: you have a 10am sync, so start early or shift to afternoon."
```

## Context Propagation

Each domain agent call includes:

```markdown
## User Context
User: Ryan
Time: 9:15 AM ET (Tuesday)

## Recent Conversation
> Ryan: What do I have going on today?
> Akasha: Let me check your schedule and tasks...
> Ryan: What's my workout today and any calendar conflicts?

## Your Task
What workout is scheduled for today based on the practice schedule?

## Instructions
- Answer ONLY the question above
- Be concise — response will be synthesized
- Do not ask clarifying questions
```

### Building Context Programmatically

```javascript
function buildContextPrompt(subQuestion, history, user = "Ryan") {
  const recentTurns = history.slice(-5).map(t =>
    `> ${t.sender}: ${t.content}`
  ).join('\n');

  return `
## User Context
User: ${user}
Time: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}

## Recent Conversation
${recentTurns}

## Your Task
${subQuestion}

## Instructions
- Answer ONLY the question above
- Be concise — response will be synthesized with other agents
- Do not ask clarifying questions — work with what you have
- Include [ACTION REQUIRED] flags for things Ryan needs to do
`;
}
```

## Timeout Handling

Domain agents have different latency expectations:

| Tier | Timeout | Examples |
|------|---------|----------|
| fast | 10s | #cubing, #spanish, #self, #system-tasks |
| medium | 30s | #fitness, #finances, #travel, most domains |
| slow | 60s | #system-planning, #dev |

### Timeout Strategy

```javascript
const TIMEOUTS = {
  fast: 10000,
  medium: 30000,
  slow: 60000
};

// When spawning agents, track start time
const agentCalls = targets.map(target => ({
  ...target,
  startTime: Date.now(),
  timeout: TIMEOUTS[target.latency_tier || 'medium']
}));

// In synthesis, note any timeouts
const responses = agentCalls.map(call => {
  if (call.response) {
    return { agent: call.name, response: call.response };
  } else if (Date.now() - call.startTime > call.timeout) {
    return { agent: call.name, timedOut: true };
  }
});
```

### Graceful Degradation

If an agent times out:
1. Proceed with available responses
2. Note the gap in synthesis: "I couldn't reach #travel for permit details"
3. Offer to retry if critical: "Want me to check back?"

## Priority Sequencing

Some queries have dependencies:

```json
{
  "targets": [
    { "folder": "whatsapp_finances", "priority": 1 },  // Check budget first
    { "folder": "whatsapp_shopping", "priority": 2 }   // Then research purchase
  ]
}
```

- **Same priority**: Execute in parallel
- **Different priority**: Execute sequentially (lower number first)

### Implementation

```javascript
// Group by priority
const priorityGroups = groupBy(targets, 'priority');
const sortedPriorities = Object.keys(priorityGroups).sort((a, b) => a - b);

for (const priority of sortedPriorities) {
  const group = priorityGroups[priority];

  // Spawn all agents in this priority group in parallel
  const responses = await Promise.all(
    group.map(target => spawnDomainAgent(target))
  );

  // Collect responses before moving to next priority
  results.push(...responses);
}
```

## Error Handling

### Agent Errors

If a domain agent fails (not timeout, but actual error):
- Log the error for debugging
- Exclude from synthesis
- Note in response: "#vehicles encountered an error checking maintenance status"

### Routing Errors

If routing itself fails:
- Fall back to self-handled
- Respond with: "I'm having trouble reaching my domain specialists. Let me try to help directly..."

## Monitoring

Track for observability:
- Routing decisions (which agents, why)
- Agent latencies (actual vs expected tier)
- Timeout rates per agent
- Synthesis quality (user feedback)

This data feeds back into registry updates (adjusting latency_tier) and prompt tuning.
