# 🕷️ VENOM

**High-performance, fully agentic CLI tool with multi-model orchestration via NVIDIA NIM.**

VENOM is a polyglot CLI that orchestrates multiple AI agents to plan, code, debug, and validate software—autonomously. It uses a 4-agent architecture powered by NVIDIA NIM API models, with a native C acceleration layer and dual interfaces (Terminal + Telegram).

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    USER INPUT                          │
│              (Terminal CLI / Telegram Bot)              │
└────────────────┬───────────────────────────────────────┘
                 │
                 ▼
┌────────────────────────────────────────────────────────┐
│           MAIN OVERVIEW AGENT (Flash Brain)            │
│         deepseek-ai/deepseek-v4-flash                  │
│  • Prompt optimization  • Traffic routing              │
│  • User-facing summaries • Token management            │
└───┬──────────────┬──────────────┬──────────────────────┘
    │              │              │
    ▼              ▼              ▼
┌────────┐  ┌───────────┐  ┌────────────┐
│PLANNER │  │  CODER    │  │  DEBUGGER  │
│kimi-k1 │  │qwen2.5   │  │nemotron-49b│
│  .5    │  │-coder-32b│  │            │
└────────┘  └───────────┘  └────────────┘
```

**Sub-agents NEVER talk to the user.** All communication flows through the Main Agent.

---

## Quick Start

### Install via pip

```bash
pip install venom-cli
```

### Set your API key

```bash
export NVIDIA_NIM_API_KEY=your_nvidia_nim_api_key
```

### Run

```bash
venom
```

---

## Execution Modes

### Mode 1: Standalone (Direct Answers)

Just type a question — the Main Agent responds directly without triggering the sub-agent pipeline.

```
❯ venom  What is a binary search tree?
```

### Mode 2: Agentic Pipeline

Use `/code`, `/vibe`, or `/build` to trigger the full autonomous loop:

```
❯ venom  /code Build a REST API with Express and PostgreSQL
```

**Pipeline flow:**
1. **Prompt Optimization** — Main Agent cleans and densifies your request
2. **Architecture Planning** — Planning Agent generates technical specification
3. **User Approval Gate** — 2-line summary + approve/revise
4. **Code Generation** — Coding Agent produces complete source files
5. **Autonomous Debug Loop** — Sandbox execution → Debugger validation → auto-fix cycle

### File Context

Reference local files with `@`:

```
❯ venom  /code Add auth middleware to @src/server.ts using @.env config
```

---

## Telegram Bot

Run with a Telegram bot token to enable the Telegram gateway:

```bash
venom --telegram-token YOUR_BOT_TOKEN

# Or Telegram-only mode (no interactive CLI):
venom --telegram-only --telegram-token YOUR_BOT_TOKEN
```

The Telegram bot supports the same commands: `/code`, `/vibe`, `/build`, `/help`.

---

## Development Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- npm

### Build from Source

```bash
# Clone
git clone https://github.com/venom-cli/venom.git
cd venom/venom-cli

# Install Node.js dependencies and compile TypeScript
npm install
npm run build

# (Optional) Compile native C module
npm run build:native

# Install Python package in dev mode
pip install -e .

# Run
venom
```

---

## Project Structure

```
venom-cli/
├── pyproject.toml                # PEP 621 Python package config
├── setup.py                      # Build script (native C + TS compilation)
├── package.json                  # Node.js dependencies
├── tsconfig.json                 # TypeScript compiler config
├── binding.gyp                   # node-gyp native module config
├── venom/
│   ├── __init__.py               # Python package init
│   ├── main.py                   # Python entry point (Node runtime + Telegram)
│   ├── canvas.ts                 # Right-to-left animated ASCII spider logo
│   ├── sandbox.ts                # Subprocess execution & log capture
│   ├── telegram.ts               # Telegram BotFather integration
│   ├── orchestrator/             # ◀ Multi-module orchestration engine
│   │   ├── index.ts              #   Boot entry point & barrel exports
│   │   ├── types.ts              #   Shared types, interfaces, enums, constants
│   │   ├── agents.ts             #   4-agent cluster configuration & registry
│   │   ├── nim_client.ts         #   NVIDIA NIM API client (retry, streaming)
│   │   ├── context.ts            #   File context extraction (@ references)
│   │   ├── code_writer.ts        #   Code file extraction & disk writer
│   │   ├── state.ts              #   Pipeline state machine & conversation history
│   │   ├── debug_loop.ts         #   Autonomous debug cycle
│   │   ├── pipeline.ts           #   Core agentic pipeline execution engine
│   │   └── repl.ts               #   Interactive terminal REPL
│   └── native/
│       └── native_core.c         # N-API C module (fast string ops)
└── README.md
```

### Orchestrator Module Breakdown

| File | Responsibility |
|---|---|
| `types.ts` | Central type system — all interfaces, enums, constants |
| `agents.ts` | 4-agent cluster definitions (models, prompts, temperatures) |
| `nim_client.ts` | NVIDIA NIM API: retry, backoff, streaming, progress indicators |
| `context.ts` | Resolves `@file` references — reads files/dirs into context blocks |
| `code_writer.ts` | Extracts code from LLM output (3 strategies), writes to disk safely |
| `state.ts` | Event-driven state machine with validated transitions + history |
| `debug_loop.ts` | Autonomous test→validate→fix cycle (up to 8 iterations) |
| `pipeline.ts` | Orchestrates all agents through the full lifecycle |
| `repl.ts` | Terminal REPL with styled help, stats, and command parsing |
| `index.ts` | Barrel exports + boot sequence |

---

## Tech Stack

| Layer              | Technology            | Purpose                                    |
|--------------------|-----------------------|--------------------------------------------|
| Primary Engine     | Node.js + TypeScript  | Async loops, state machine, CLI rendering  |
| Native Performance | C (N-API)             | Ultra-fast string/AST manipulation         |
| Scripting Layer    | Python 3              | Entry point, background tasks, packaging   |
| AI Backend         | NVIDIA NIM API        | Multi-model agent orchestration            |
| Distribution       | pip / PyPI            | `pip install venom-cli`                    |

---

## Environment Variables

| Variable              | Description                          | Required |
|-----------------------|--------------------------------------|----------|
| `NVIDIA_NIM_API_KEY`  | NVIDIA NIM API authentication key    | Yes      |
| `VENOM_TELEGRAM_TOKEN`| Telegram BotFather API token         | No       |

---

## License

MIT
