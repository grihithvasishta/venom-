"""
VENOM CLI - Build Script
Compiles native C module via node-gyp and transpiles TypeScript sources.
"""

import os
import sys
import subprocess
import shutil
from setuptools import setup, find_packages
from setuptools.command.build_py import build_py
from setuptools.command.develop import develop


ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
VENOM_DIR = os.path.join(ROOT_DIR, "venom")
NATIVE_DIR = os.path.join(VENOM_DIR, "native")


def compile_native_module():
    """Compile the C native module using node-gyp via N-API."""
    binding_gyp = os.path.join(ROOT_DIR, "binding.gyp")
    if not os.path.exists(binding_gyp):
        print("[VENOM BUILD] WARNING: binding.gyp not found, skipping native compilation.")
        return

    print("[VENOM BUILD] Compiling native C module via node-gyp...")
    try:
        subprocess.check_call(
            ["node-gyp", "rebuild"],
            cwd=ROOT_DIR,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        # Copy the compiled .node binary into the package
        build_release = os.path.join(ROOT_DIR, "build", "Release", "native_core.node")
        if os.path.exists(build_release):
            dest = os.path.join(NATIVE_DIR, "native_core.node")
            shutil.copy2(build_release, dest)
            print(f"[VENOM BUILD] Native module copied to {dest}")
        else:
            print("[VENOM BUILD] WARNING: Compiled .node binary not found in build/Release/")
    except FileNotFoundError:
        print("[VENOM BUILD] WARNING: node-gyp not found. Native module will not be compiled.")
        print("[VENOM BUILD]          Install node-gyp globally: npm install -g node-gyp")
    except subprocess.CalledProcessError as e:
        print(f"[VENOM BUILD] WARNING: Native compilation failed (exit code {e.returncode}).")
        print("[VENOM BUILD]          The CLI will run without native acceleration.")


def transpile_typescript():
    """Transpile TypeScript source files to JavaScript using tsc."""
    tsconfig = os.path.join(ROOT_DIR, "tsconfig.json")
    package_json = os.path.join(ROOT_DIR, "package.json")

    if not os.path.exists(package_json):
        print("[VENOM BUILD] WARNING: package.json not found, skipping TypeScript transpilation.")
        return

    print("[VENOM BUILD] Installing Node.js dependencies...")
    try:
        subprocess.check_call(
            ["npm", "install", "--production=false"],
            cwd=ROOT_DIR,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"[VENOM BUILD] WARNING: npm install failed: {e}")
        return

    print("[VENOM BUILD] Transpiling TypeScript sources...")
    try:
        subprocess.check_call(
            ["npx", "tsc", "--project", tsconfig],
            cwd=ROOT_DIR,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        print("[VENOM BUILD] TypeScript transpilation complete.")
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        print(f"[VENOM BUILD] WARNING: TypeScript compilation failed: {e}")


class VenomBuildPy(build_py):
    """Custom build step that compiles native code and transpiles TypeScript."""

    def run(self):
        compile_native_module()
        transpile_typescript()
        super().run()


class VenomDevelop(develop):
    """Custom develop step for editable installs."""

    def run(self):
        compile_native_module()
        transpile_typescript()
        super().run()


setup(
    cmdclass={
        "build_py": VenomBuildPy,
        "develop": VenomDevelop,
    },
)
