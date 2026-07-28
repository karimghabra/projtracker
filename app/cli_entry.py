"""PyInstaller entry point for the bundled CLI.

The desktop app ships this as a sidecar so an installed copy needs neither
Python nor a checkout of the repository. It is the same `main` the terminal
CLI uses -- there is no second implementation of anything.
"""
import sys

from protracker.cli import main

if __name__ == "__main__":
    sys.exit(main())
