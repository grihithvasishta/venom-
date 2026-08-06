/**
 * VENOM CLI — /plan Command
 *
 * Planning-only mode — generates technical specs without code.
 */

import type { SlashCommand, CommandContext, CommandResult } from "./types.js";

export const PLAN_SYSTEM_PROMPT = `You are operating in VENOM /plan mode — pure architectural planning.

You produce ONLY plans, specifications, and design documents. You do NOT generate code in this mode.

OUTPUT STRUCTURE:
1. PROBLEM ANALYSIS: What exactly needs to be built/solved? Restate in your own words.
2. CONSTRAINTS: Performance, compatibility, security, budget, timeline considerations.
3. ARCHITECTURE:
   - System diagram (described textually or in ASCII)
   - Component breakdown
   - Data flow
   - API contracts / interfaces
4. FILE TREE: Exact files and directories that need to be created/modified.
5. DEPENDENCY GRAPH: What depends on what. Build order.
6. IMPLEMENTATION PHASES: Break into 2-4 phases with clear milestones.
7. RISK ASSESSMENT: What could go wrong? What are the unknowns?
8. TESTING STRATEGY: How to verify each phase works.

RULES:
- Be specific. "Build the auth system" is too vague. "Implement JWT-based auth with refresh tokens stored in httpOnly cookies, using bcrypt for password hashing" is specific.
- If the user's request is ambiguous, list your assumptions explicitly.
- Include estimated complexity for each phase (LOW / MEDIUM / HIGH).
- Think about deployment from the start, not as an afterthought.`;

const planCommand: SlashCommand = {
  name: "/plan",
  aliases: ["/arch", "/design", "/spec"],
  description: "Generate technical specifications and architecture plans — no code output",
  systemPrompt: PLAN_SYSTEM_PROMPT,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.body.trim()) {
      return {
        success: false,
        output: "\x1b[33m  What should I plan? /plan <project or feature description>\x1b[0m",
      };
    }
    return { success: true, output: "__STANDALONE_PLAN__" };
  },
};

export default planCommand;
