"""
VENOM CLI - Python Entry Point
Launches the Node.js orchestrator and optionally the Telegram gateway.
"""

import os
import sys
import signal
import subprocess
import argparse
import threading
from pathlib import Path

VENOM_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = VENOM_DIR.parent
ORCHESTRATOR_JS = PROJECT_ROOT / "orchestrator" / "index.js"
TELEGRAM_JS = PROJECT_ROOT / "gateway" / "telegram.js"


def _find_node() -> str:
    try:
        from nodejs.binaries import node as nb
        if os.path.isfile(nb):
            return str(nb)
    except ImportError:
        pass
    try:
        from nodejs import node as _nm
        np = getattr(_nm, "path", None)
        if np and os.path.isfile(np):
            return str(np)
    except (ImportError, AttributeError):
        pass
    import shutil
    sn = shutil.which("node") or shutil.which("nodejs")
    if sn:
        return sn
    print("\033[91m[VENOM FATAL]\033[0m Node.js not found.", file=sys.stderr)
    sys.exit(1)


class TelegramGateway(threading.Thread):
    def __init__(self, node: str, token: str):
        super().__init__(daemon=True, name="venom-tg")
        self.node = node
        self.token = token
        self._proc = None

    def run(self):
        env = os.environ.copy()
        env["VENOM_TELEGRAM_TOKEN"] = self.token
        try:
            self._proc = subprocess.Popen(
                [self.node, str(TELEGRAM_JS)], env=env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            if self._proc.stdout:
                for line in iter(self._proc.stdout.readline, b""):
                    d = line.decode("utf-8", errors="replace").rstrip()
                    if d:
                        print(f"\033[36m[TG]\033[0m {d}")
            self._proc.wait()
        except Exception as e:
            print(f"\033[91m[TG ERROR]\033[0m {e}", file=sys.stderr)

    def stop(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()


def main():
    parser = argparse.ArgumentParser(prog="venom", description="VENOM — Agentic CLI")
    parser.add_argument("--telegram-token", metavar="T", default=os.environ.get("VENOM_TELEGRAM_TOKEN", ""))
    parser.add_argument("--telegram-only", action="store_true")
    parser.add_argument("--api-key", metavar="K", default=os.environ.get("NVIDIA_NIM_API_KEY", ""))
    args = parser.parse_args()

    node = _find_node()

    if not ORCHESTRATOR_JS.exists():
        print(f"\033[91m[VENOM FATAL]\033[0m Engine not found: {ORCHESTRATOR_JS}", file=sys.stderr)
        print("  Run: npm run build", file=sys.stderr)
        sys.exit(1)

    tg = None
    if args.telegram_token:
        tg = TelegramGateway(node, args.telegram_token)
        tg.start()
        print("\033[32m[VENOM]\033[0m Telegram started.")

    if args.telegram_only:
        if not tg:
            print("\033[91m[VENOM]\033[0m --telegram-only needs --telegram-token.", file=sys.stderr)
            sys.exit(1)
        print("\033[32m[VENOM]\033[0m Telegram-only. Ctrl+C to stop.")
        try:
            tg.join()
        except KeyboardInterrupt:
            tg.stop()
        return

    env = os.environ.copy()
    if args.api_key:
        env["NVIDIA_NIM_API_KEY"] = args.api_key
    if args.telegram_token:
        env["VENOM_TELEGRAM_TOKEN"] = args.telegram_token

    signal.signal(signal.SIGINT, lambda *_: (tg and tg.stop(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (tg and tg.stop(), sys.exit(0)))

    try:
        r = subprocess.run([node, str(ORCHESTRATOR_JS)], env=env, cwd=str(Path.cwd()))
        sys.exit(r.returncode)
    except KeyboardInterrupt:
        print("\n\033[33m[VENOM]\033[0m Ended.")
    finally:
        if tg:
            tg.stop()


if __name__ == "__main__":
    main()
