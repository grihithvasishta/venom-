/**
 * VENOM CLI — Terminal Canvas & Boot Sequence
 *
 * Renders the animated ASCII spider + "VENOM" block-text logo with a
 * RIGHT-TO-LEFT reveal sweep and a multi-color gradient (deep violet/magenta
 * → toxic neon lime green) using raw ANSI escape codes.
 */

// ---------------------------------------------------------------------------
// ANSI Helpers
// ---------------------------------------------------------------------------

function fg(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const BOLD = "\x1b[1m";

// ---------------------------------------------------------------------------
// Gradient: Deep Violet → Hot Magenta → Toxic Neon Lime
// ---------------------------------------------------------------------------

interface RGB { r: number; g: number; b: number; }

const GRAD_A: RGB = { r: 100, g: 0, b: 180 };
const GRAD_B: RGB = { r: 200, g: 0, b: 140 };
const GRAD_C: RGB = { r: 57, g: 255, b: 20 };

function lerp(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function gradient(t: number): RGB {
  return t < 0.5 ? lerp(GRAD_A, GRAD_B, t * 2) : lerp(GRAD_B, GRAD_C, (t - 0.5) * 2);
}

// ---------------------------------------------------------------------------
// ASCII Art
// ---------------------------------------------------------------------------

const LOGO: string[] = [
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

const MAX_W = Math.max(...LOGO.map((l) => l.length));
const FRAME = LOGO.map((l) => l.padEnd(MAX_W));
const ROWS = FRAME.length;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function colorRow(row: string, ri: number, reveal: number): string {
  let out = "";
  for (let c = 0; c < row.length; c++) {
    if (c < reveal) { out += " "; continue; }
    const ch = row[c];
    if (ch === " ") { out += " "; continue; }
    const t = Math.min(1, c / MAX_W + (ri / ROWS) * 0.15);
    const col = gradient(t);
    out += BOLD + fg(col.r, col.g, col.b) + ch + RESET;
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function playBootAnimation(): Promise<void> {
  const out = process.stdout;
  const w = Math.min(MAX_W, out.columns || 120);

  out.write(CURSOR_HIDE);
  for (let i = 0; i < ROWS; i++) out.write("\n");
  out.write(`\x1b[${ROWS}A`);

  let reveal = w;
  while (reveal >= 0) {
    out.write(`\x1b[${ROWS}A`);
    for (let r = 0; r < ROWS; r++) out.write(`\x1b[2K${colorRow(FRAME[r], r, reveal)}\n`);
    reveal -= 4;
    await sleep(18);
  }

  // Final render
  out.write(`\x1b[${ROWS}A`);
  for (let r = 0; r < ROWS; r++) out.write(`\x1b[2K${colorRow(FRAME[r], r, 0)}\n`);
  await sleep(300);
  out.write(CURSOR_SHOW + "\n");
}

if (require.main === module) {
  playBootAnimation().catch(console.error);
}
