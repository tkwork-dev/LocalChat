"""図のサーバーサイドレンダリング（PlantUML）。

完全オフライン環境向けに、社内へ配置した plantuml.jar（Java）を用いて
PlantUML ソースを SVG へ変換する。外部サービスには一切接続しない。
PLANTUML_JAR が未設定、または Java が利用できない場合は available=false を返し、
フロントエンドはソースコード表示にフォールバックする。
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from ..config import settings
from ..deps import get_current_user
from ..models import User

router = APIRouter(prefix="/api/render", tags=["render"])

# 描画結果の簡易メモリキャッシュ（ソースのハッシュ→SVG）
_cache: dict[str, str] = {}
_MAX_SOURCE = 20_000  # 過大な入力を拒否


class PlantUmlRequest(BaseModel):
    source: str = Field(max_length=_MAX_SOURCE)


def _plantuml_available() -> bool:
    if not settings.PLANTUML_JAR:
        return False
    if not Path(settings.PLANTUML_JAR).exists():
        return False
    if shutil.which(settings.JAVA_BIN) is None:
        return False
    return True


@router.get("/capabilities")
def capabilities(_: User = Depends(get_current_user)):
    """利用可能なサーバーサイド描画機能を返す。"""
    return {"plantuml": _plantuml_available()}


@router.post("/plantuml")
def render_plantuml(payload: PlantUmlRequest, _: User = Depends(get_current_user)):
    source = payload.source
    if not _plantuml_available():
        return {"available": False, "svg": None}

    key = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if key in _cache:
        return {"available": True, "svg": _cache[key]}

    try:
        # -pipe で標準入力からソースを受け取り、SVG を標準出力へ。
        # セキュリティプロファイルを制限（バージョン差異に備え env と -D の両方を指定）。
        child_env = os.environ.copy()
        child_env["PLANTUML_SECURITY_PROFILE"] = "SANDBOX"
        result = subprocess.run(
            [
                settings.JAVA_BIN,
                "-Djava.awt.headless=true",
                "-Dplantuml.security.profile=SANDBOX",
                "-jar",
                settings.PLANTUML_JAR,
                "-tsvg",
                "-pipe",
                "-charset",
                "UTF-8",
            ],
            input=source.encode("utf-8"),
            capture_output=True,
            timeout=20,
            env=child_env,
        )
    except (subprocess.TimeoutExpired, OSError):
        return {"available": True, "svg": None, "error": "描画がタイムアウトしました"}

    if result.returncode != 0 or not result.stdout:
        return {"available": True, "svg": None, "error": "PlantUMLの描画に失敗しました"}

    svg = result.stdout.decode("utf-8", errors="replace")
    # <svg> 以降のみを採用（前置きの警告等を除去）
    idx = svg.find("<svg")
    if idx > 0:
        svg = svg[idx:]
    _cache[key] = svg
    return {"available": True, "svg": svg}
