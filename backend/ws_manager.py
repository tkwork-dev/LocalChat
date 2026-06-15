"""WebSocket 接続マネージャ。

リアルタイム双方向通信を司る。外部のメッセージブローカーや
Push通知サーバーは使用せず、プロセス内でクライアント接続を管理する。
"""
from __future__ import annotations

import asyncio
from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    """ユーザーIDごとに複数のWebSocket接続を保持する。"""

    def __init__(self) -> None:
        # user_id -> その人の接続集合（複数端末/タブ対応）
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[user_id].add(websocket)

    async def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        async with self._lock:
            conns = self._connections.get(user_id)
            if conns and websocket in conns:
                conns.discard(websocket)
                if not conns:
                    self._connections.pop(user_id, None)

    async def send_to_users(self, user_ids: list[int], message: dict) -> None:
        """指定ユーザー群へイベントを送信する。"""
        targets: list[WebSocket] = []
        async with self._lock:
            for uid in set(user_ids):
                targets.extend(self._connections.get(uid, set()))
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                # 送信失敗（切断済み等）は無視。クリーンアップは受信側ループで実施。
                pass

    def online_user_ids(self) -> list[int]:
        return list(self._connections.keys())


manager = ConnectionManager()
