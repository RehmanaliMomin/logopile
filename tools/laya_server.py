#!/usr/bin/env python3
"""
Minimal /v1/systemone server for Laya, using only the standard library.

`pip install "laya[serve]"` advertises FastAPI + uvicorn but installs neither at
0.3.4, and no `laya-serve` entry point exists, so this is the smallest thing
that speaks the documented API.

    python3 -m venv .venv && .venv/bin/pip install laya
    HF_TOKEN=$(cat ~/.claude/secrets/huggingface-token) .venv/bin/python tools/laya_server.py

Then point the app at it:  echo 'VITE_LAYA_URL=http://localhost:8000' >> .env.local
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import laya

PORT = int(os.environ.get("LAYA_PORT", "8000"))

print("loading laya…", file=sys.stderr)
_t = time.time()
AGENT = laya.load(token=os.environ.get("HF_TOKEN"))
print(f"ready in {time.time() - _t:.0f}s on :{PORT}", file=sys.stderr)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # The page is served from another origin in dev and from GitHub Pages in
        # production; without CORS the browser never sees the response.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/systemone":
            return self._send(404, {"error": "not found"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            out = AGENT.system_one(req.get("state", ""), req.get("questions", {}))
            self._send(200, json.loads(json.dumps(out, default=str)))
        except Exception as exc:  # noqa: BLE001 — surface it to the client, keep serving
            self._send(500, {"error": str(exc)})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
