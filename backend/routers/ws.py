"""WebSocket エンドポイントと既読状態管理。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models
from ..database import SessionLocal, get_db
from ..deps import get_current_user
from ..security import decode_access_token
from ..ws_manager import manager

router = APIRouter(tags=["realtime"])


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = ""):
    """リアルタイム通知用 WebSocket。

    接続: ws(s)://host/ws?token=<アクセストークン>
    """
    user_id = decode_access_token(token)
    if user_id is None:
        await websocket.close(code=4401)  # 認証エラー
        return

    # ユーザー存在確認
    db = SessionLocal()
    try:
        user = db.get(models.User, user_id)
        if user is None or not user.is_active:
            await websocket.close(code=4401)
            return
    finally:
        db.close()

    await manager.connect(user_id, websocket)
    try:
        # ハートビート/受信ループ。クライアントからのメッセージは現状ping用途。
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(user_id, websocket)


# ---- 既読管理（未読バッジ用） ----
read_router = APIRouter(prefix="/api", tags=["read"])


@read_router.post("/channels/{channel_id}/read")
def mark_channel_read(
    channel_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    last = db.scalar(
        select(models.Message.id)
        .where(models.Message.channel_id == channel_id)
        .order_by(models.Message.id.desc())
        .limit(1)
    )
    _upsert_read(db, current.id, channel_id=channel_id, last_id=last or 0)
    db.commit()
    return {"ok": True, "last_read_message_id": last or 0}


@read_router.post("/dms/{dm_id}/read")
def mark_dm_read(
    dm_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    last = db.scalar(
        select(models.Message.id)
        .where(models.Message.dm_channel_id == dm_id)
        .order_by(models.Message.id.desc())
        .limit(1)
    )
    _upsert_read(db, current.id, dm_channel_id=dm_id, last_id=last or 0)
    db.commit()
    return {"ok": True, "last_read_message_id": last or 0}


@read_router.get("/unread")
def get_unread(
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """チャンネル/DMごとの未読件数を返す。"""
    result: dict[str, dict[int, int]] = {"channels": {}, "dms": {}}

    # 既読状態をマップ化
    states = db.scalars(
        select(models.ReadState).where(models.ReadState.user_id == current.id)
    ).all()
    ch_read = {s.channel_id: s.last_read_message_id for s in states if s.channel_id}
    dm_read = {
        s.dm_channel_id: s.last_read_message_id for s in states if s.dm_channel_id
    }

    # 所属サーバーのチャンネル未読
    server_ids = db.scalars(
        select(models.ServerMember.server_id).where(
            models.ServerMember.user_id == current.id
        )
    ).all()
    if server_ids:
        channels = db.scalars(
            select(models.Channel).where(models.Channel.server_id.in_(server_ids))
        ).all()
        for ch in channels:
            last_read = ch_read.get(ch.id, 0)
            count = db.scalar(
                _count_stmt(models.Message.channel_id == ch.id, last_read, current.id)
            )
            if count:
                result["channels"][ch.id] = count

    # DM未読
    dm_ids = db.scalars(
        select(models.DMMember.dm_channel_id).where(
            models.DMMember.user_id == current.id
        )
    ).all()
    for dm_id in dm_ids:
        last_read = dm_read.get(dm_id, 0)
        count = db.scalar(
            _count_stmt(models.Message.dm_channel_id == dm_id, last_read, current.id)
        )
        if count:
            result["dms"][dm_id] = count

    return result


def _count_stmt(channel_condition, last_read: int, user_id: int):
    from sqlalchemy import func

    return (
        select(func.count(models.Message.id))
        .where(channel_condition)
        .where(models.Message.id > last_read)
        .where(models.Message.author_id != user_id)
        .where(models.Message.is_deleted.is_(False))
    )


def _upsert_read(
    db: Session,
    user_id: int,
    last_id: int,
    channel_id: int | None = None,
    dm_channel_id: int | None = None,
) -> None:
    stmt = select(models.ReadState).where(models.ReadState.user_id == user_id)
    if channel_id is not None:
        stmt = stmt.where(models.ReadState.channel_id == channel_id)
    else:
        stmt = stmt.where(models.ReadState.dm_channel_id == dm_channel_id)
    state = db.scalar(stmt)
    if state is None:
        state = models.ReadState(
            user_id=user_id,
            channel_id=channel_id,
            dm_channel_id=dm_channel_id,
            last_read_message_id=last_id,
        )
        db.add(state)
    else:
        state.last_read_message_id = max(state.last_read_message_id, last_id)
