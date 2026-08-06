/**
 * VENOM CLI — /shell Command
 *
 * Agentic shell execution — the AI can plan and execute shell commands
 * autonomously with full safety enforcement. Every command passes through
 * the multi-tier security guard before execution.
 */

import * as readline from "node:readline";
import type { SlashCommand, CommandContext, CommandResult } from "./types.js";
import { Sandbox } from "../core/sandbox.js";
import {
  validateCommand,
  formatVerdict,
  ThreatLevel,
} from "../core/safety.js";

export const SHELL_SYSTEM_PROMPT = `You are operating in VENOM /shell mode — intelligent shell command execution.

You are an expert systems administrator and DevOps engineer. The user needs help executing shell commands on their local machine.

BEHAVIORAL RULES:
- Suggest the exact shell command needed. Be precise — no guessing.
- Always explain WHAT the command does and WHY before execution.
- Prefer non-destructive read-only commands when possible.
- For file modifications, prefer atomic operations (write to temp, then move).
- Chain commands with && not ; (fail-fast behavior).
- Respect the user's OS — check if Windows (PowerShell/cmd) or Unix (bash/zsh).
- For dangerous operations, explicitly warn the user and suggest safer alternatives.

OUTPUT FORMAT:
- Present the command in a code block: \`\`\`bash\\n<command>\\n\`\`\`
- Include a 1-line explanation before the command.
- After execution, summarize the output concisely.

SAFETY RULES:
- NEVER suggest commands that delete data without explicit user intent.
- NEVER pipe curl/wget output directly to shell interpreters.
- NEVER modify system files, credentials, or SSH keys.
- NEVER run commands that require root/admin unless the user explicitly asks.
- Always prefer reversible operations over irreversible ones.`;

function askUser(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

const shellCommand: SlashCommand = {
  name: "/shell",
  aliases: ["/sh", "/exec", "/run"],
  description: "Execute shell commands with AI guidance and safety enforcement",
  systemPrompt: SHELL_SYSTEM_PROMPT,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.body.trim()) {
      return {
        success: false,
        output: "\x1b[33m  Usage: /shell <command or description>\x1b[0m\n" +
                "\x1b[90m  Direct:    /shell ls -la\x1b[0m\n" +
                "\x1b[90m  Describe:  /shell show me all running node processes\x1b[0m",
      };
    }

    const input = ctx.body.trim();
    const sandbox = new Sandbox();

    // Check if this looks like a direct command (starts with common executables)
    const directCommandPattern = /^(?:ls|dir|cat|echo|pwd|cd|mkdir|touch|cp|mv|rm|git|npm|npx|node|python|pip|docker|kubectl|curl|wget|find|grep|ps|top|df|du|which|where|type|set|Get-|Select-|Write-|Test-)/i;
    const isDirectCommand = directCommandPattern.test(input);

    if (isDirectCommand) {
      // Direct execution with safety check
      const verdict = validateCommand(input);

      console.log(`\n  \x1b[90m$ ${input}\x1b[0m`);
      console.log(`  ${formatVerdict(verdict)}`);

      if (verdict.level === ThreatLevel.BLOCKED) {
        return {
          success: false,
          output: `\x1b[91m  Command blocked by safety policy: ${verdict.reason}\x1b[0m`,
          alreadyPrinted: true,
        };
      }

      if (verdict.level === ThreatLevel.CONFIRM && ctx.rl) {
        const answer = await askUser(
          ctx.rl,
          `\x1b[33m  ⚠ ${verdict.reason}. Proceed? (y/n): \x1b[0m`
        );
        if (!answer.toLowerCase().startsWith("y")) {
          return { success: false, output: "  Command cancelled.", alreadyPrinted: true };
        }
      }

      const result = await sandbox.execute(input, {
        cwd: ctx.cwd,
        timeoutMs: 30_000,
      });

      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.log(`\x1b[91m${result.stderr}\x1b[0m`);
      console.log(`\x1b[90m  Exit: ${result.exitCode} | ${result.durationMs}ms\x1b[0m`);

      return { success: result.exitCode === 0, alreadyPrinted: true };
    }

    // Natural language — signal the REPL to use the AI with shell system prompt
    return { success: true, output: "__STANDALONE_SHELL__" };
  },
};

export default shellCommand;
