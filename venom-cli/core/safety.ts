/**
 * VENOM CLI — Security Guard & Safety Layer
 *
 * Provides multi-tier command validation, path traversal protection,
 * dangerous pattern detection, and runtime policy enforcement.
 * This module is the SINGLE GATE for all shell execution — no bypass allowed.
 */

// ---------------------------------------------------------------------------
// Threat Classification
// ---------------------------------------------------------------------------

export enum ThreatLevel {
  SAFE = "SAFE",
  WARN = "WARN",           // Allowed but user gets a warning
  CONFIRM = "CONFIRM",     // Requires explicit user confirmation
  BLOCKED = "BLOCKED",     // Hard-blocked, no override
}

export interface SecurityVerdict {
  level: ThreatLevel;
  reason: string;
  matched?: string;
}

// ---------------------------------------------------------------------------
// Blocked Command Patterns (HARD BLOCK — no override)
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[rR]f?|--recursive)\s+[\/\\]/,        reason: "Recursive deletion from root" },
  { pattern: /\brm\s+(-[rR]f?|--recursive)\s+~\//,           reason: "Recursive deletion from home" },
  { pattern: /\brm\s+-[rR]f?\s+\.\s*$/,                      reason: "Recursive deletion of current directory" },
  { pattern: /\bformat\s+[a-zA-Z]:/i,                         reason: "Disk formatting" },
  { pattern: /\bmkfs\b/i,                                     reason: "Filesystem creation on device" },
  { pattern: /\bdd\s+.*of=\/dev\//i,                          reason: "Raw device write via dd" },

  // System destruction
  { pattern: /:()\s*\{\s*:\|:&\s*\}\s*;/,                     reason: "Fork bomb" },
  { pattern: /\bshutdown\b/i,                                  reason: "System shutdown" },
  { pattern: /\breboot\b/i,                                    reason: "System reboot" },
  { pattern: /\bhalt\b/i,                                      reason: "System halt" },
  { pattern: /\binit\s+0\b/,                                   reason: "Runlevel 0 (halt)" },
  { pattern: />\s*\/dev\/sd[a-z]/i,                            reason: "Raw block device write" },
  { pattern: />\s*\/dev\/nvme/i,                               reason: "Raw NVMe device write" },

  // Privilege escalation
  { pattern: /\bchmod\s+.*777\s+\//,                           reason: "Recursive chmod 777 from root" },
  { pattern: /\bchown\s+.*-R\s+.*\//,                         reason: "Recursive chown from root" },

  // Credential theft
  { pattern: /\bcat\s+.*\/etc\/shadow\b/,                      reason: "Shadow file access" },
  { pattern: /\bcat\s+.*\.ssh\/id_/,                           reason: "SSH key exfiltration" },
  { pattern: /curl\s+.*\|\s*sh\b/,                             reason: "Piped remote code execution" },
  { pattern: /wget\s+.*\|\s*sh\b/,                             reason: "Piped remote code execution" },
  { pattern: /curl\s+.*\|\s*bash\b/,                           reason: "Piped remote code execution" },

  // Windows-specific
  { pattern: /\bdel\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/,            reason: "Recursive delete from C:\\" },
  { pattern: /\brd\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/,             reason: "Recursive rmdir from C:\\" },
  { pattern: /\breg\s+delete\s+HKLM/i,                        reason: "Registry deletion (HKLM)" },
  { pattern: /Set-ExecutionPolicy\s+Unrestricted/i,            reason: "PowerShell execution policy bypass" },
];

// ---------------------------------------------------------------------------
// Confirmation-Required Patterns (CONFIRM — user must approve)
// ---------------------------------------------------------------------------

const CONFIRM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[rRf]/,                                  reason: "Recursive/forced file deletion" },
  { pattern: /\bsudo\b/,                                       reason: "Superuser command" },
  { pattern: /\bdoas\b/,                                       reason: "Privilege escalation via doas" },
  { pattern: /\brunas\b/i,                                     reason: "Run as different user (Windows)" },
  { pattern: /\bnpm\s+install\s+-g\b/,                         reason: "Global npm install" },
  { pattern: /\bpip\s+install\b/,                              reason: "Python package install" },
  { pattern: /\bapt\s+install\b/,                              reason: "System package install" },
  { pattern: /\bbrew\s+install\b/,                             reason: "Homebrew package install" },
  { pattern: /\bdocker\s+rm\b/,                                reason: "Docker container removal" },
  { pattern: /\bgit\s+push\s+.*--force\b/,                    reason: "Force push to git remote" },
  { pattern: /\bgit\s+reset\s+--hard\b/,                      reason: "Hard git reset" },
  { pattern: /\bdrop\s+database\b/i,                           reason: "Database drop" },
  { pattern: /\bdrop\s+table\b/i,                              reason: "Table drop" },
  { pattern: /\btruncate\b/i,                                  reason: "Table truncation" },
  { pattern: /\bcurl\b.*-[oO]\b/,                              reason: "File download via curl" },
  { pattern: /\bwget\b/,                                       reason: "File download via wget" },
  { pattern: /\bkill\s+-9\b/,                                  reason: "Force kill process" },
  { pattern: /\bkillall\b/,                                    reason: "Kill all processes by name" },
  { pattern: /\btaskkill\b/i,                                  reason: "Windows process kill" },
  { pattern: /\bchmod\b/,                                      reason: "File permission change" },
  { pattern: /\bmkdir\s+-p\s+\//,                             reason: "Root-level directory creation" },
  { pattern: /Set-ExecutionPolicy/i,                            reason: "PowerShell execution policy change" },
];

// ---------------------------------------------------------------------------
// Warning Patterns (WARN — allowed but flagged)
// ---------------------------------------------------------------------------

const WARN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\benv\b/,                                         reason: "Environment variable access" },
  { pattern: /\bexport\b/,                                     reason: "Environment variable export" },
  { pattern: /\bsystemctl\b/,                                  reason: "Service management" },
  { pattern: /\bnetstat\b/i,                                   reason: "Network inspection" },
  { pattern: /\bss\b\s+-/,                                     reason: "Socket statistics" },
  { pattern: /\bnmap\b/,                                       reason: "Network scanning" },
  { pattern: /\bgit\s+clone\b/,                                reason: "Repository cloning" },
  { pattern: /\bnpx\b/,                                        reason: "npx execution" },
];

// ---------------------------------------------------------------------------
// Path Safety Validation
// ---------------------------------------------------------------------------

const PROTECTED_PATHS = [
  "/etc", "/boot", "/usr", "/sbin", "/bin", "/lib",
  "/System", "/Library",
  "C:\\Windows", "C:\\Program Files",
];

export function isPathProtected(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, "/").toLowerCase();
  return PROTECTED_PATHS.some((p) =>
    normalized.startsWith(p.replace(/\\/g, "/").toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Command Length & Complexity Guards
// ---------------------------------------------------------------------------

const MAX_COMMAND_LENGTH = 2048;
const MAX_PIPE_DEPTH = 5;
const MAX_CHAINED_COMMANDS = 8;

function checkComplexity(command: string): SecurityVerdict | null {
  if (command.length > MAX_COMMAND_LENGTH) {
    return {
      level: ThreatLevel.BLOCKED,
      reason: `Command exceeds max length (${command.length}/${MAX_COMMAND_LENGTH} chars)`,
    };
  }

  const pipeCount = (command.match(/\|/g) || []).length;
  if (pipeCount > MAX_PIPE_DEPTH) {
    return {
      level: ThreatLevel.CONFIRM,
      reason: `Deep pipe chain (${pipeCount} pipes — max ${MAX_PIPE_DEPTH})`,
    };
  }

  const chainCount = (command.match(/&&|;\s/g) || []).length;
  if (chainCount > MAX_CHAINED_COMMANDS) {
    return {
      level: ThreatLevel.CONFIRM,
      reason: `Too many chained commands (${chainCount} — max ${MAX_CHAINED_COMMANDS})`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main Validation Function
// ---------------------------------------------------------------------------

/**
 * Validate a shell command against all security tiers.
 * Returns the highest-severity verdict found.
 */
export function validateCommand(command: string): SecurityVerdict {
  const trimmed = command.trim();

  // Empty command — safe
  if (!trimmed) {
    return { level: ThreatLevel.SAFE, reason: "Empty command" };
  }

  // Tier 0: Complexity guards
  const complexityResult = checkComplexity(trimmed);
  if (complexityResult) return complexityResult;

  // Tier 1: Hard-blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: ThreatLevel.BLOCKED,
        reason,
        matched: pattern.source,
      };
    }
  }

  // Tier 2: Confirmation-required patterns
  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: ThreatLevel.CONFIRM,
        reason,
        matched: pattern.source,
      };
    }
  }

  // Tier 3: Warning patterns
  for (const { pattern, reason } of WARN_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: ThreatLevel.WARN,
        reason,
        matched: pattern.source,
      };
    }
  }

  return { level: ThreatLevel.SAFE, reason: "No threats detected" };
}

/**
 * Format a security verdict for terminal display.
 */
export function formatVerdict(verdict: SecurityVerdict): string {
  switch (verdict.level) {
    case ThreatLevel.BLOCKED:
      return `\x1b[91m✗ BLOCKED:\x1b[0m ${verdict.reason}`;
    case ThreatLevel.CONFIRM:
      return `\x1b[33m⚠ REQUIRES CONFIRMATION:\x1b[0m ${verdict.reason}`;
    case ThreatLevel.WARN:
      return `\x1b[33m⚡ WARNING:\x1b[0m ${verdict.reason}`;
    case ThreatLevel.SAFE:
      return `\x1b[32m✓ SAFE\x1b[0m`;
  }
}

/**
 * Sanitize command output — strip credentials, tokens, secrets.
 */
export function sanitizeOutput(output: string): string {
  // Redact common secret patterns
  let sanitized = output;
  sanitized = sanitized.replace(
    /(?:api[_-]?key|token|secret|password|passwd|pwd|auth)\s*[=:]\s*\S+/gi,
    "[REDACTED]"
  );
  sanitized = sanitized.replace(
    /Bearer\s+[A-Za-z0-9._~+\/=-]+/g,
    "Bearer [REDACTED]"
  );
  sanitized = sanitized.replace(
    /(?:sk|pk|rk)[-_][A-Za-z0-9]{20,}/g,
    "[REDACTED_KEY]"
  );
  return sanitized;
}
