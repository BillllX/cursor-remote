#!/usr/bin/env python3
"""Move a single-tenant cursor-remote data dir into tenants/default.

Rewrites absolute cwd/gitDir/workTree in state.json and renames shadow-git
dirs whose names are sha1(cwd)[:16]. Idempotent if tenants/default already exists.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys


def sha16(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


def rewrite_prefix(value: object, old: str, new: str) -> object:
    if isinstance(value, str) and (value == old or value.startswith(old.rstrip("/") + "/")):
        return new + value[len(old) :]
    if isinstance(value, list):
        return [rewrite_prefix(item, old, new) for item in value]
    if isinstance(value, dict):
        return {key: rewrite_prefix(item, old, new) for key, item in value.items()}
    return value


def main() -> int:
    state_dir = os.path.abspath(os.environ.get("CURSOR_REMOTE_STATE_DIR", "/var/lib/cursor-remote"))
    old_cwd = os.path.abspath(os.environ.get("CURSOR_REMOTE_CWD", os.path.join(state_dir, "workspace")))
    dest = os.path.join(state_dir, "tenants", "default")
    new_cwd = os.path.join(dest, "workspace")
    if os.path.isdir(dest) and os.path.exists(os.path.join(dest, "state.json")):
        print(f"已存在 {dest}，跳过迁移。")
        return 0

    os.makedirs(dest, exist_ok=True)
    old_state = os.path.join(state_dir, "state.json")
    new_state = os.path.join(dest, "state.json")
    old_shadow = os.path.join(state_dir, "shadow-git")
    new_shadow = os.path.join(dest, "shadow-git")

    if os.path.isdir(old_cwd) and not os.path.exists(new_cwd):
        shutil.move(old_cwd, new_cwd)
        print(f"工作区 {old_cwd} -> {new_cwd}")
    elif not os.path.exists(new_cwd):
        os.makedirs(new_cwd, exist_ok=True)

    if os.path.isfile(old_state) and not os.path.exists(new_state):
        shutil.move(old_state, new_state)
        print(f"状态 {old_state} -> {new_state}")

    if os.path.isdir(old_shadow) and not os.path.exists(new_shadow):
        shutil.move(old_shadow, new_shadow)
        print(f"检查点库 {old_shadow} -> {new_shadow}")

    if os.path.isfile(new_state):
        with open(new_state, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        data = rewrite_prefix(data, old_cwd, new_cwd)
        data = rewrite_prefix(data, old_shadow, new_shadow)
        with open(new_state, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        print("已重写 state.json 里的绝对路径")

        os.makedirs(new_shadow, exist_ok=True)
        seen = set()
        for slot in data.get("slots") or []:
            cwd = slot.get("cwd") if isinstance(slot, dict) else None
            if not isinstance(cwd, str) or cwd in seen:
                continue
            seen.add(cwd)
            old_name = sha16(cwd.replace(new_cwd, old_cwd) if cwd.startswith(new_cwd) else cwd)
            new_name = sha16(cwd)
            src = os.path.join(new_shadow, old_name)
            dst = os.path.join(new_shadow, new_name)
            if old_name != new_name and os.path.isdir(src) and not os.path.exists(dst):
                shutil.move(src, dst)
                print(f"shadow-git {old_name} -> {new_name}")

    print("迁移完成。把旧 CURSOR_REMOTE_TOKEN 写进 tenants.json 的 default.token 后重启 gateway。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
