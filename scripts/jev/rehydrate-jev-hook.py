#!/usr/bin/env python3
"""Source-only lifecycle repair. Each invocation reads persisted state afresh.

No service start, container mutation or activation is performed by importing this module.
The operator must approve installation and API mutation separately.
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def rehydrate(db_path, base, *, timeout=90, opener=urllib.request.urlopen,
              sleep=time.sleep, monotonic=time.monotonic):
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password:
        raise ValueError("local API required")
    # Read-only connection: do not create a missing DB or edit saved state.
    with sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True) as conn:
        key_row = conn.execute("SELECT key FROM api_keys WHERE name=?", ("omniroute-verify",)).fetchone()
        row = conn.execute("SELECT description,priority,code,enabled FROM middleware_hooks WHERE name=?", ("jev-router",)).fetchone()
    if not key_row or not row:
        raise ValueError("persisted hook configuration missing")
    body = json.dumps({"description": row[0], "priority": row[1], "code": row[2],
                       "enabled": bool(row[3]), "scope": {"type": "global"}}).encode()
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        try:
            with opener(base + "/api/health", timeout=2) as response:
                if response.status != 200:
                    raise ValueError("not ready")
            break
        except Exception:
            sleep(1)
    else:
        raise TimeoutError("API readiness deadline")
    request = urllib.request.Request(base + "/api/middleware/hooks/jev-router", data=body,
                                    headers={"Authorization": "Bearer " + key_row[0], "Content-Type": "application/json"}, method="PUT")
    # No blind mutation retry after ambiguous failure. Next timer tick reloads the
    # persisted desired state; PUT is an idempotent replacement of this named hook.
    with opener(request, timeout=5) as response:
        if not 200 <= response.status < 300:
            raise ValueError("rehydration rejected")


def main():
    try:
        rehydrate(os.environ["OMNIROUTE_DB"], os.environ.get("OMNIROUTE_LOCAL_API", "http://127.0.0.1:20129"))
    except Exception:
        print("jev rehydration failed; inspect local readiness and persisted configuration", file=sys.stderr)
        return 1
    print("jev persisted hook rehydrated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
