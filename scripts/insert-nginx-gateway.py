#!/usr/bin/env python3
"""Insert /cursor-remote/bridge and /cursor-remote/media in front of the existing UI location."""
from pathlib import Path

CONF = Path("/etc/nginx/conf.d/ai-assistant.conf")
MARKER = "    location ^~ /cursor-remote {"
BLOCK = """    location ^~ /cursor-remote/bridge {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
        proxy_redirect off;
    }

    location ^~ /cursor-remote/media {
        proxy_pass http://127.0.0.1:8787/media;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_hide_header Upgrade;
        proxy_read_timeout 120;
        proxy_redirect off;
        access_log off;
    }

"""

text = CONF.read_text()
if "location ^~ /cursor-remote/bridge" in text:
    print("already present")
    raise SystemExit(0)
count = text.count(MARKER)
if count < 1:
    raise SystemExit("cursor-remote location not found; aborting")
CONF.write_text(text.replace(MARKER, BLOCK + MARKER))
print("inserted gateway locations into", count, "blocks")
