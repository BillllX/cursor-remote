#!/usr/bin/env python3
"""Proxy /p/ on the station's existing TLS vhost. Does not add a certificate."""
from pathlib import Path
import os
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "scripts" / "nginx-publish-location.conf"
SNIPPET = Path("/etc/nginx/snippets/jiebo-publish-location.conf")
CONF_DIR = Path("/etc/nginx/conf.d")
MAP = CONF_DIR / "00-jiebo-publish-upgrade.conf"
INCLUDE = "include /etc/nginx/snippets/jiebo-publish-location.conf;"
UPGRADE_MAP = """map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
"""


def server_blocks(text: str):
    found = []
    i = 0
    while True:
        match = re.search(r"\bserver\s*\{", text[i:])
        if not match:
            break
        start = i + match.start()
        brace = i + match.end() - 1
        depth = 0
        end = None
        for j in range(brace, len(text)):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if end is None:
            break
        found.append((start, end))
        i = end
    return found


def server_names(block: str):
    names = []
    for line in block.splitlines():
        stripped = line.strip()
        if not stripped.startswith("server_name"):
            continue
        names.extend(stripped.removeprefix("server_name").rstrip(";").split())
    return names


def splice(text: str, host: str) -> tuple[str, int]:
    inserts = []
    for start, end in server_blocks(text):
        block = text[start:end]
        if not re.search(r"\blisten\s+(\[::\]:)?443\b", block):
            continue
        if host not in server_names(block):
            continue
        if "jiebo-publish-location.conf" in block or "location ^~ /p/" in block:
            continue
        inserts.append(end - 1)
    if not inserts:
        return text, 0
    for pos in reversed(inserts):
        text = text[:pos] + f"\n    {INCLUDE}\n" + text[pos:]
    return text, len(inserts)


def main():
    host = clean_host(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("JIEBO_PUBLISH_HOST", ""))
    if not host:
        sys.exit("用法：JIEBO_PUBLISH_HOST=jiebo.aiagentswitcher.com python3 scripts/insert-nginx-publish.py")
    if not SRC.exists():
        sys.exit(f"missing {SRC}")
    SNIPPET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SRC, SNIPPET)
    print("snippet", SNIPPET)
    if not any("map $http_upgrade $connection_upgrade" in conf.read_text() for conf in CONF_DIR.glob("*.conf")):
        MAP.write_text(UPGRADE_MAP)
        print("map", MAP)
    changed = 0
    if not CONF_DIR.is_dir():
        sys.exit(f"没有 {CONF_DIR}")
    for conf in sorted(CONF_DIR.glob("*.conf")):
        original = conf.read_text()
        updated, count = splice(original, host)
        if count:
            conf.write_text(updated)
            changed += count
            print(f"added {INCLUDE} x{count} in {conf}")
    if not changed:
        print(f"没改 nginx：没有 listen 443 且 server_name 正好是 {host} 的站点，或 /p/ 已经在里面。")
        raise SystemExit(0)
    print("接着：nginx -t && systemctl reload nginx")
    print(f"并在 /etc/cursor-remote/gateway.env 设置 JIEBO_PUBLISH_HOST={host} 后重启 gateway。")


def clean_host(raw: str) -> str:
    value = raw.strip().lower().rstrip(".")
    if value.startswith("*."):
        value = value[2:]
    if not value or re.search(r"[:/\s*]", value) or not re.fullmatch(r"[a-z0-9.-]+", value):
        return ""
    return value


if __name__ == "__main__":
    main()
