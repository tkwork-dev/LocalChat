"""LocalChat アプリケーションエントリポイント。

完全オフライン環境で動作する社内チャットアプリ。
FastAPI + WebSocket + SQLite で構成し、外部サービスに一切依存しない。
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .database import init_db
from .network_guard import (
    DEFAULT_PRIVATE_CIDRS,
    PrivateNetworkGuard,
    parse_networks,
)
from .routers import auth, dms, files, invites, messages, render, servers, users, ws

settings.ensure_dirs()
init_db()


def _install_conn_reset_filter() -> None:
    """Windows の ProactorEventLoop で発生する無害な ConnectionResetError を抑制する。

    クライアントが接続を突然切断（ページ再読込・タブクローズ・WebSocket切断など）
    した際に出る WinError 10054 はアプリの動作に影響しないため、ログから除外する。
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    default_handler = loop.get_exception_handler()

    def handler(loop, context):
        exc = context.get("exception")
        if isinstance(exc, ConnectionResetError):
            return  # 無害なため無視
        if default_handler is not None:
            default_handler(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _install_conn_reset_filter()
    yield


app = FastAPI(
    title="LocalChat",
    description="完全オフライン社内チャット",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS 設定（docs/ の図エラー検証ラボを別オリジンで開いた際のプリフライト対応）
_cors_origins = [o.strip() for o in settings.CORS_ALLOW_ORIGINS.split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# プライベートネットワーク限定アクセス制御（グローバルIPからのアクセスを拒否）
if settings.RESTRICT_TO_PRIVATE:
    _cidrs = (
        [c for c in settings.ALLOWED_CIDRS.split(",") if c.strip()]
        or DEFAULT_PRIVATE_CIDRS
    )
    app.add_middleware(
        PrivateNetworkGuard,
        networks=parse_networks(_cidrs),
        trust_forwarded=settings.TRUST_FORWARDED_FOR,
    )

# API ルーター登録
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(servers.router)
app.include_router(invites.router)
app.include_router(messages.router)
app.include_router(dms.router)
app.include_router(files.router)
app.include_router(render.router)
app.include_router(ws.router)
app.include_router(ws.read_router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ---- フロントエンド配信（ローカルホスティング。外部CDN不使用） ----
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

if _FRONTEND_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=str(_FRONTEND_DIR / "static")),
        name="static",
    )

    @app.get("/")
    def index():
        return FileResponse(str(_FRONTEND_DIR / "index.html"))

    @app.get("/favicon.ico", include_in_schema=False)
    def favicon():
        return FileResponse(str(_FRONTEND_DIR / "static" / "favicon.ico"))


def run() -> None:
    """uvicorn でサーバーを起動する。"""
    import uvicorn

    ssl_kwargs = {}
    if settings.SSL_CERTFILE and settings.SSL_KEYFILE:
        # 必要に応じて自己署名証明書を自動生成・自動更新する
        if settings.TLS_AUTO_GENERATE:
            from .tls import ensure_cert

            ensure_cert(
                settings.SSL_CERTFILE,
                settings.SSL_KEYFILE,
                settings.TLS_RENEW_DAYS,
            )
        ssl_kwargs = {
            "ssl_certfile": settings.SSL_CERTFILE,
            "ssl_keyfile": settings.SSL_KEYFILE,
        }

    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        **ssl_kwargs,
    )


if __name__ == "__main__":
    run()
