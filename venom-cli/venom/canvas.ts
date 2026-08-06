/**
 * VENOM CLI — Terminal Canvas & Boot Sequence
 *
 * Renders the animated ASCII spider + "VENOM" block-text logo with a
 * RIGHT-TO-LEFT reveal sweep and a multi-color gradient (deep violet/magenta
 * → toxic neon lime green) using raw ANSI escape codes.
 *
 * No version numbers, no fluff — just the aggressive spider and VENOM.
 */

// ---------------------------------------------------------------------------
// ANSI Escape Helpers
// ---------------------------------------------------------------------------

/** Generate a 24-bit true-color foreground escape sequence. */
function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Reset all ANSI styles. */
const RESET = "\x1b[0m";

/** Hide / show cursor. */
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

// ---------------------------------------------------------------------------
// Gradient Palette: Deep Violet/Magenta → Toxic Neon Lime
// ---------------------------------------------------------------------------

interface RGB {
  r: number;
  g: number;
  b: number;
}

const GRADIENT_START: RGB = { r: 100, g: 0, b: 180 }; // deep violet
const GRADIENT_MID: RGB = { r: 200, g: 0, b: 140 };   // hot magenta
const GRADIENT_END: RGB = { r: 57, g: 255, b: 20 };    // toxic neon lime

function lerpColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function gradientColor(t: number): RGB {
  if (t < 0.5) {
    return lerpColor(GRADIENT_START, GRADIENT_MID, t * 2);
  }
  return lerpColor(GRADIENT_MID, GRADIENT_END, (t - 0.5) * 2);
}

// ---------------------------------------------------------------------------
// ASCII Art: Aggressive Mechanical Spider + "VENOM" Block Text
// ---------------------------------------------------------------------------

const SPIDER_VENOM_LINES: string[] = [
  `        .                                                                                 `,
  `       /|\\          _____                                                                 `,
  `      / | \\        / ____|                                                                `,
  `     /  |  \\      / /                                                                     `,
  `    /___|___\\    | |        __   __ _____ _   _  ___  __  __                               `,
  `   /|   .   |\\   | |        \\ \\ / /| ____| \\ | |/ _ \\|  \\/  |                             `,
  `  / |  /|\\  | \\  | |         \\ V / |  _| |  \\| | | | | |\\/| |                             `,
  ` /__|_/ | \\_|__\\  \\ \\____     | |  | |___| |\\  | |_| | |  | |                             `,
  `|  __   |   __|    \\_____|    |_|  |_____|_| \\_|\\___/|_|  |_|                             `,
  `| /  \\  |  /  \\                                                                           `,
  `|/ /\\ \\ | / /\\ \\                                                                          `,
  `  / /\\ \\|/ /\\ \\                                                                           `,
  ` / /  \\_V_/  \\ \\                                                                          `,
  `/_/    |||    \\_\\                                                                         `,
  `       |||                                                                                 `,
  `      /||\\                                                                                `,
  `     / || \\                                                                               `,
  `    /  ||  \\                                                                              `,
];

// Pre-pad all lines to the same width
const MAX_WIDTH = Math.max(...SPIDER_VENOM_LINES.map((l) => l.length));
const FRAME_LINES = SPIDER_VENOM_LINES.map((l) => l.padEnd(MAX_WIDTH));
const TOTAL_ROWS = FRAME_LINES.length;

// ---------------------------------------------------------------------------
// Right-to-Left Reveal Renderer
// ---------------------------------------------------------------------------

function colorizeRow(row: string, rowIndex: number, revealCol: number): string {
  let result = "";
  for (let col = 0; col < row.length; col++) {
    const ch = row[col];
    if (col < revealCol) {
      // Not yet revealed — render blank
      result += " ";
    } else {
      if (ch === " ") {
        result += " ";
      } else {
        // Gradient based on column position (left=violet, right=lime)
        const t = col / MAX_WIDTH;
        // Mix in a subtle row-based shift for depth
        const rowShift = (rowIndex / TOTAL_ROWS) * 0.15;
        const c = gradientColor(Math.min(1, t + rowShift));
        result += fg(c.r, c.g, c.b) + ch + RESET;
      }
    }
  }
  return result;
}

function renderFrame(revealCol: number): string[] {
  return FRAME_LINES.map((row, idx) => colorizeRow(row, idx, revealCol));
}

// ---------------------------------------------------------------------------
// Animation Controller
// ---------------------------------------------------------------------------

const SWEEP_SPEED = 4;        // columns revealed per tick
const TICK_INTERVAL_MS = 18;  // ms between ticks

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function playBootAnimation(): Promise<void> {
  const stdout = process.stdout;
  const termCols = stdout.columns || 120;

  // Use MAX_WIDTH or terminal width, whichever is smaller
  const effectiveWidth = Math.min(MAX_WIDTH, termCols);

  stdout.write(CURSOR_HIDE);

  // Reserve lines in scroll history
  for (let i = 0; i < TOTAL_ROWS; i++) {
    stdout.write("\n");
  }

  // Move cursor up to the start of reserved block
  stdout.write(`\x1b[${TOTAL_ROWS}A`);
  const startRow = (): void => {
    stdout.write(`\x1b[${TOTAL_ROWS}A`);
  };

  // Sweep from right to left: revealCol starts at effectiveWidth (nothing shown)
  // and decreases to 0 (fully shown)
  let revealCol = effectiveWidth;

  while (revealCol >= 0) {
    const frame = renderFrame(revealCol);
    startRow();
    for (let r = 0; r < TOTAL_ROWS; r++) {
      // Clear the line, write the frame row, move to next line
      stdout.write(`\x1b[2K${frame[r]}\n`);
    }
    revealCol -= SWEEP_SPEED;
    await sleep(TICK_INTERVAL_MS);
  }

  // Final full render (ensure col=0)
  const finalFrame = renderFrame(0);
  startRow();
  for (let r = 0; r < TOTAL_ROWS; r++) {
    stdout.write(`\x1b[2K${finalFrame[r]}\n`);
  }

  // Brief hold, then show cursor
  await sleep(300);
  stdout.write(CURSOR_SHOW);
  stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Standalone execution
// ---------------------------------------------------------------------------
if (require.main === module) {
  playBootAnimation().catch(console.error);
}
