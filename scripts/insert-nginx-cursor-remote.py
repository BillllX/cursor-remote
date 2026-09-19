#!/usr/bin/env python3
"""Insert /cursor-remote into existing nginx servers without touching other locations."""
from pathlib import Path

CONF = Path("/etc/nginx/conf.d/ai-assistant.conf")
NEEDLE = "    location / {\n        proxy_pass http://127.0.0.1:3010;"
BLOCK = """    # cursor-remote (add-only)
    location ^~ /cursor-remote {
        proxy_pass http://127.0.0.1:3020;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_read_timeout 86400;
        proxy_redirect off;
    }

"""

text = CONF.read_text()
if "location ^~ /cursor-remote" in text:
    print("already present")
    raise SystemExit(0)
if NEEDLE not in text:
    raise SystemExit("needle not found; aborting so existing nginx is untouched")
count = text.count(NEEDLE)
if count != 2:
    raise SystemExit(f"expected 2 default location / blocks, found {count}; aborting")
CONF.write_text(text.replace(NEEDLE, BLOCK + NEEDLE))
print("inserted into", count, "server blocks")
