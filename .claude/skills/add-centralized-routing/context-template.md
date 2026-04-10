# Context Template

This template is used when calling domain agents. It provides the context they need to answer without starting cold.

---

## User Context

**User**: {{USER_NAME}}
**Time**: {{CURRENT_TIME}}
**Day**: {{DAY_OF_WEEK}}

## Recent Conversation

{{LAST_N_TURNS}}

## Your Task

{{SUB_QUESTION}}

## Instructions

1. **Answer ONLY the question above** — stay focused on your domain
2. **Be concise** — your response will be synthesized with other agents' responses
3. **If you cannot answer**, say so clearly and explain why
4. **Do not ask clarifying questions** — work with the information provided
5. **Include source references** when citing specific data (file names, dates, etc.)

## Response Format

Provide your answer as clear, factual text. Do not wrap in JSON or add metadata — the orchestrator handles synthesis.

If you need to flag something important:
- **[ACTION REQUIRED]**: Something Ryan needs to do
- **[CONFLICT]**: Information that contradicts another source
- **[OUTDATED]**: Data that may be stale and should be verified

---

## Example

**User**: Ryan
**Time**: 9:15 AM ET
**Day**: Tuesday

**Recent Conversation**:
> Ryan: What do I have going on today?
> Akasha: Checking your schedule and tasks...

**Your Task**: What workout is scheduled for today based on the practice schedule?

**Expected Response**:
Today is Tuesday — your Strength Training day. The session is:
- **Calisthenics: Planche/Lever + False Grip + Flexibility**
- Scheduled for the morning block (6:30 AM)
- Location: Home gym

Current status: Upper body work is active. Lower body remains paused due to fibula recovery (Phase 2).

[ACTION REQUIRED] PT routine is scheduled for 5:00 PM — don't skip it.
