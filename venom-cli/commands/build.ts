/**
 * VENOM CLI — /build Command
 *
 * Triggers the agentic pipeline with a system prompt tuned for
 * full-stack project scaffolding and build automation.
 */

import type { SlashCommand, CommandContext, CommandResult } from "./types.js";

export const BUILD_SYSTEM_PROMPT = `You are operating in VENOM /build mode — full-stack project builder.

You specialize in scaffolding entire projects from scratch. When given a project description:

1. ARCHITECTURE FIRST: Define the tech stack, folder structure, and dependency graph before writing any code.
2. CONFIG FILES FIRST: Generate package.json, tsconfig.json, .env.example, Dockerfile, etc. BEFORE source code.
3. COMPLETE SCAFFOLDING: Generate every file needed for a working project — not just the "interesting" parts.
4. BUILD PIPELINE: Include build scripts, linting config, and basic CI/CD (GitHub Actions or similar).
5. WORKING OUT OF THE BOX: The generated project must run immediately after file creation with a single command (npm start, python main.py, etc.).

Include:
- README.md with setup instructions
- .gitignore appropriate for the stack
- Environment variable templates (.env.example)
- Basic test file structure
- Entry point that actually does something visible (not just "Hello World" — show the stack working)

OUTPUT FORMAT: Each file in \`\`\`filepath:path/to/file\`\`\` fenced blocks.`;

const buildCommand: SlashCommand = {
  name: "/build",
  aliases: ["/scaffold", "/init"],
  description: "Scaffold a complete project from scratch — configs, source, tests, CI",
  systemPrompt: BUILD_SYSTEM_PROMPT,

  async execute(ctx: CommandContext): Promise<CommandResult> {
    if (!ctx.body.trim()) {
      return {
        success: false,
        output: "\x1b[33m  Describe your project: /build <project description>\x1b[0m",
      };
    }
    return { success: true, output: "__PIPELINE__" };
  },
};

export default buildCommand;
