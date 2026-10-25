"""Compare configured mount paths without resolving every individual file."""
import os
from pathlib import Path


def path_key(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(value)))


def media_path_aliases(entries) -> list[dict[str, str]]:
    aliases = []
    for entry in entries:
        source = Path(entry.path).expanduser()
        try:
            resolved = source.resolve()
        except OSError:
            resolved = source
        aliases.append({'path': str(source), 'resolved_path': str(resolved)})
    return aliases


def canonical_path_key(value: str | Path, aliases) -> str:
    key = path_key(value)
    for alias in sorted(aliases, key=lambda item: len(path_key(item['path'])), reverse=True):
        source = path_key(alias['path'])
        if key == source or key.startswith(source.rstrip(os.sep) + os.sep):
            return path_key(os.path.join(alias['resolved_path'], key[len(source):].lstrip(os.sep)))
    return key
