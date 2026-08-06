/**
 * VENOM CLI — Command Types
 *
 * Type definitions for the slash command system.
 */

export interface CommandContext {
  /** Raw user input after the slash command. */
  body: string;
  /** Working directory. */
  cwd: string;
  /** Readline interface for interactive prompts. */
  rl?: import("node:readline").Interface;
}

export interface CommandResult {
  /** Whether the command completed successfully. */
  success: boolean;
  /** Output message to display. */
  output?: string;
  /** If true, the output was already printed (skip display). */
  alreadyPrinted?: boolean;
}

export interface SlashCommand {
  /** The slash trigger (e.g. "/code"). */
  name: string;
  /** Aliases that also trigger this command. */
  aliases: string[];
  /** Short description for /help. */
  description: string;
  /** The dedicated system prompt that shapes AI behavior for this mode. */
  systemPrompt: string;
  /** Execute the command. */
  execute(ctx: CommandContext): Promise<CommandResult>;
}
