"""CLI uses UTF-8 JSON / NDJSON on stdout; never launches a shell."""
import argparse
import json
import sys
from pathlib import Path

from pocket_restore.engine import RestoreError, capabilities, inspect, run_job


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("capabilities")
    inspection = commands.add_parser("inspect")
    inspection.add_argument("path")
    restore = commands.add_parser("restore")
    restore.add_argument("--request", required=True)
    args = parser.parse_args()
    try:
        if args.command == "capabilities":
            emit(capabilities())
        elif args.command == "inspect":
            emit(inspect(args.path))
        else:
            request_path = Path(args.request)
            if request_path.stat().st_size > 8 * 1024 * 1024:
                raise RestoreError("任务文件过大")
            request = json.loads(request_path.read_text(encoding="utf-8-sig"))
            result = run_job(request, emit)
            return 130 if result["cancelled"] else (1 if result["failed"] else 0)
        return 0
    except (RestoreError, OSError, ValueError) as exc:
        emit({"type": "job_error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
