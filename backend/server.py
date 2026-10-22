#!/usr/bin/env python3
"""Local MLX-Whisper transcription backend for voice-transcriber.

Stdlib-only HTTP server (no Flask/FastAPI), matching serve.py's style. Loads the
MLX-converted Dutch Whisper model once at startup and keeps it warm for the life of
the process. See README.md in this directory for setup instructions.

Protocol:
  GET  /health      -> 200 {"status": "ok"}
  OPTIONS /transcribe -> 204 (CORS preflight)
  POST /transcribe   -> body: raw little-endian float32 PCM at 16 kHz (mono, -1..1)
                        response: 200 {"chunks": [{"timestamp": [start, end], "text": "..."}]}
                        or non-2xx {"error": "..."}
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import mlx_whisper

MODEL_DIR = Path(__file__).parent / "models" / "yuriyvnv-nl"
HOST, PORT = "0.0.0.0", 8000
SAMPLE_RATE = 16000

_lock = threading.Lock()


def transcribe(audio: np.ndarray) -> list[dict]:
    with _lock:
        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=str(MODEL_DIR),
            language="nl",
            condition_on_previous_text=False,
            verbose=False,
        )
    return [
        {"timestamp": [seg["start"], seg["end"]], "text": seg["text"]}
        for seg in result["segments"]
    ]


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Sample-Rate")

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            audio = np.frombuffer(body, dtype="<f4")
            chunks = transcribe(audio)
            self._json(200, {"chunks": chunks})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


def main():
    if not (MODEL_DIR / "weights.safetensors").exists():
        sys.exit(
            f"Modelmap niet gevonden: {MODEL_DIR}\n"
            "Zie backend/README.md voor hoe je het model daar plaatst."
        )
    print("Model laden…", flush=True)
    transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))  # warm up
    print(f"Model geladen, klaar voor verzoeken op http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
