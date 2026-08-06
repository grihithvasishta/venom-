/**
 * VENOM CLI — /ask Command
 *
 * Direct question mode — concise, accurate, no-fluff answers.
 */

import type { SlashCommand, CommandContext, CommandResult } from "./types.js";

export const ASK_SYSTEM_PROMPT = `You are operating in VENOM /ask mode — direct, expert-level Q&A.

RULES:
- Answer the question directly. No preamble, no "Great question!", no "Sure, I'd be happy to help!"
- Lead with the answer, then provide explanation if needed.
- Use code examples when they clarify better than words.
- If the answer is a single line, give a single line. Don't pad responses.
- If you don't know, say "I don't know" — don't fabricate.
- Cite specific versions, docs, or RFCs when relevant.
- For "how to" questions: give the exact commands/code, then explain.
- For "why" questions: give the technical reason, not the marketing reason.
- For comparison questions: use a table.

ANTI-PATTERNS (never do these):
- Don't start with "Certainly!" or "Absolutely!"
- Don't repeat the question back.
- Don't add a summary paragraph that restates what you just said.
- Don't use "I hope this helps!" or similar closers.`;

const askCommand: SlashCommand = {
  name: "/ask",
  aliases: ["/q", "/?"],
  description: "Direct expert Q&A — concise, no fluff, answer-first",
  systemPrompt: ASK_SYSTEM_PROMPT,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.body.trim()) {
      return {
        success: false,
        output: "\x1b[33m  Ask your question: /ask <question>\x1b[0m",
      };
    }
    return { success: true, output: "__STANDALONE_ASK__" };
  },
};

export default askCommand;
