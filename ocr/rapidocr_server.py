# /// script
# requires-python = ">=3.10"
# dependencies = ["rapidocr", "openvino"]
# ///
"""
Long-lived RapidOCR worker.

Reads framed JPEG/PNG images on stdin and writes one JSON response per image
on stdout. Frame format (little ceremony, just enough to be robust):

    request  := <4-byte big-endian length><N bytes image>
    response := <one JSON line>\n

On startup, emits a single readiness line so the parent can block until init
is finished:

    {"ready": true, "backend": "openvino", "init_ms": 1234}

A length of 0 means "shut down cleanly".

The parent process owns the lifecycle: spawn once, reuse for many recognize
calls, terminate on disconnect.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import time


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _read_exact(n: int) -> bytes:
    """Read exactly n bytes from stdin, or return b'' on clean EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return bytes(buf)
        buf.extend(chunk)
    return bytes(buf)


def main() -> int:
    backend = os.environ.get("RAPIDOCR_BACKEND", "openvino").lower()
    try:
        from rapidocr import EngineType, RapidOCR
    except Exception as e:
        _emit({"ready": False, "error": f"rapidocr import failed: {e}"})
        return 2

    engine_type = {
        "openvino": EngineType.OPENVINO,
        "onnxruntime": EngineType.ONNXRUNTIME,
        "onnx": EngineType.ONNXRUNTIME,
    }.get(backend, EngineType.ONNXRUNTIME)

    t0 = time.perf_counter()
    try:
        engine = RapidOCR(
            params={
                "Det.engine_type": engine_type,
                "Rec.engine_type": engine_type,
                "Cls.engine_type": engine_type,
            }
        )
    except Exception as e:
        _emit({"ready": False, "error": f"engine init failed: {e}"})
        return 2

    init_ms = (time.perf_counter() - t0) * 1000
    _emit({"ready": True, "backend": backend, "init_ms": round(init_ms, 1)})

    while True:
        hdr = _read_exact(4)
        if len(hdr) < 4:
            return 0
        (n,) = struct.unpack(">I", hdr)
        if n == 0:
            return 0
        data = _read_exact(n)
        if len(data) < n:
            return 0

        t = time.perf_counter()
        try:
            res = engine(data)
        except Exception as e:
            _emit({"error": f"ocr failed: {e}"})
            continue

        ms = (time.perf_counter() - t) * 1000
        items = []
        boxes = getattr(res, "boxes", None)
        txts = getattr(res, "txts", None) or []
        scores = getattr(res, "scores", None) or []
        if boxes is not None:
            for box, txt, conf in zip(boxes, txts, scores):
                # box is a numpy array shaped (4,2); .tolist() gives plain [[x,y], ...].
                items.append({"box": box.tolist(), "text": txt or "", "conf": float(conf)})
        _emit({"ms": round(ms, 1), "items": items})


if __name__ == "__main__":
    sys.exit(main())
