"""VieNeu-TTS sidecar for READZO.

A thin FastAPI wrapper around the VieNeu-TTS v3-Turbo model (48 kHz, CPU/ONNX).
Express (`server.ts`) proxies `/api/tts` here; this process holds the model.

  POST /tts   { text, voice?, style? }  -> { audio: <base64 WAV>, sampleRate }
  GET  /voices                          -> { default, styles, voices: [...] }
  GET  /health                          -> { ok, ready }

Runs on port 4100 by default (outside Windows' reserved 3001-3500 range).
"""
import base64
import io
import json
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(__file__).parent / "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel

VALID_STYLES = {"tu_nhien", "tin_tuc", "doc_truyen"}
VOICES_JSON = Path(__file__).parent / ".venv" / "Lib" / "site-packages" / "vieneu" / "assets" / "voices_v3_turbo.json"

_engine = None
_load_lock = threading.Lock()
_infer_lock = threading.Lock()  # model inference is CPU-bound; serialize it


def _load_voice_catalog():
    try:
        data = json.loads(VOICES_JSON.read_text(encoding="utf-8"))
        presets = data.get("presets", {})
        voices = [
            {
                "name": name,
                "gender": v.get("gender"),
                "style": v.get("style"),
                "description": v.get("description"),
            }
            for name, v in presets.items()
        ]
        return data.get("default_voice"), voices
    except Exception:
        return None, []


DEFAULT_VOICE, VOICE_CATALOG = _load_voice_catalog()
VALID_VOICES = {v["name"] for v in VOICE_CATALOG}


def get_engine():
    global _engine
    if _engine is None:
        with _load_lock:
            if _engine is None:
                from vieneu import Vieneu

                _engine = Vieneu()  # v3-Turbo, 48 kHz, CPU via ONNX
    return _engine


@asynccontextmanager
async def lifespan(_app: "FastAPI"):
    # Load the model in the background so the first request isn't cold (~56s load).
    threading.Thread(target=get_engine, daemon=True).start()
    yield


app = FastAPI(title="READZO VieNeu-TTS", lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None
    style: str = "tu_nhien"


@app.get("/health")
def health():
    return {"ok": True, "ready": _engine is not None}


@app.get("/voices")
def voices():
    return {"default": DEFAULT_VOICE, "styles": sorted(VALID_STYLES), "voices": VOICE_CATALOG}


@app.post("/tts")
def tts(req: TTSRequest):
    text = (req.text or "").strip()
    if not text:
        return {"error": "Thiếu nội dung cần đọc."}

    style = req.style if req.style in VALID_STYLES else "tu_nhien"
    voice = req.voice if (req.voice in VALID_VOICES) else None  # None -> model default

    engine = get_engine()
    with _infer_lock:
        audio = engine.infer(text, voice=voice, style=style)

    audio = np.asarray(audio, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, audio, 48000, format="WAV", subtype="PCM_16")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"audio": b64, "sampleRate": 48000}


if __name__ == "__main__":
    port = int(os.environ.get("TTS_PORT", "4100"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
