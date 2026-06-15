"""メッセージ・スレッド・リアクション・既読管理エンドポイント。"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas, services
from ..database import get_db
from ..deps import get_current_user
from ..ws_manager import manager

router = APIRouter(prefix="/api", tags=["messages"])

_MENTION_RE = re.compile(r"@([A-Za-z0-9_\-]{2,50})")


def _resolve_targets(db: Session, msg: models.Message) -> list[int]:
    """メッセージの通知対象ユーザーIDを返す。"""
    if msg.channel_id is not None:
        channel = db.get(models.Channel, msg.channel_id)
        return services.channel_member_ids(db, channel) if channel else []
    if msg.dm_channel_id is not None:
        return services.dm_member_ids(db, msg.dm_channel_id)
    return []


def _extract_mentions(db: Session, content: str) -> list[int]:
    """本文中の @ユーザー名 を解決してユーザーIDの一覧を返す。"""
    names = set(_MENTION_RE.findall(content))
    if not names:
        return []
    users = db.scalars(
        select(models.User).where(models.User.username.in_(names))
    ).all()
    return [u.id for u in users]


# ---- チャンネルメッセージ ----
@router.get(
    "/channels/{channel_id}/messages", response_model=list[schemas.MessagePublic]
)
def list_channel_messages(
    channel_id: int,
    before: int | None = Query(default=None),
    limit: int = Query(default=50, le=100),
    parent_id: int | None = Query(default=None),
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    channel = db.get(models.Channel, channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="チャンネルが見つかりません")
    services.require_membership(db, channel.server_id, current.id)

    stmt = select(models.Message).where(models.Message.channel_id == channel_id)
    if parent_id is not None:
        stmt = stmt.where(models.Message.parent_id == parent_id)
    else:
        stmt = stmt.where(models.Message.parent_id.is_(None))
    if before:
        stmt = stmt.where(models.Message.id < before)
    stmt = stmt.order_by(models.Message.id.desc()).limit(limit)
    msgs = list(db.scalars(stmt).all())
    msgs.reverse()
    return [services.serialize_message(db, m) for m in msgs]


@router.post(
    "/channels/{channel_id}/messages", response_model=schemas.MessagePublic, status_code=201
)
async def create_channel_message(
    channel_id: int,
    payload: schemas.MessageCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    channel = db.get(models.Channel, channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="チャンネルが見つかりません")
    services.require_membership(db, channel.server_id, current.id)

    if not payload.content.strip() and not payload.attachment_ids:
        raise HTTPException(status_code=400, detail="メッセージが空です")

    msg = models.Message(
        channel_id=channel_id,
        author_id=current.id,
        content=payload.content,
        parent_id=payload.parent_id,
    )
    db.add(msg)
    db.flush()
    _attach(db, msg.id, payload.attachment_ids, current.id)
    db.commit()
    db.refresh(msg)

    data = services.serialize_message(db, msg)
    targets = _resolve_targets(db, msg)
    await manager.send_to_users(
        targets,
        {"type": "message_created", "message": data.model_dump(mode="json")},
    )
    # メンション通知
    mentioned = _extract_mentions(db, payload.content)
    if mentioned:
        await manager.send_to_users(
            mentioned,
            {
                "type": "mention",
                "message": data.model_dump(mode="json"),
                "channel_id": channel_id,
            },
        )
    return data


# ---- DMメッセージ ----
@router.get("/dms/{dm_id}/messages", response_model=list[schemas.MessagePublic])
def list_dm_messages(
    dm_id: int,
    before: int | None = Query(default=None),
    limit: int = Query(default=50, le=100),
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    if not services.is_dm_member(db, dm_id, current.id):
        raise HTTPException(status_code=403, detail="このDMにアクセスできません")
    stmt = select(models.Message).where(models.Message.dm_channel_id == dm_id)
    if before:
        stmt = stmt.where(models.Message.id < before)
    stmt = stmt.order_by(models.Message.id.desc()).limit(limit)
    msgs = list(db.scalars(stmt).all())
    msgs.reverse()
    return [services.serialize_message(db, m) for m in msgs]


@router.post(
    "/dms/{dm_id}/messages", response_model=schemas.MessagePublic, status_code=201
)
async def create_dm_message(
    dm_id: int,
    payload: schemas.MessageCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    if not services.is_dm_member(db, dm_id, current.id):
        raise HTTPException(status_code=403, detail="このDMにアクセスできません")
    if not payload.content.strip() and not payload.attachment_ids:
        raise HTTPException(status_code=400, detail="メッセージが空です")

    msg = models.Message(
        dm_channel_id=dm_id,
        author_id=current.id,
        content=payload.content,
        parent_id=payload.parent_id,
    )
    db.add(msg)
    db.flush()
    _attach(db, msg.id, payload.attachment_ids, current.id)
    db.commit()
    db.refresh(msg)

    data = services.serialize_message(db, msg)
    await manager.send_to_users(
        services.dm_member_ids(db, dm_id),
        {"type": "message_created", "message": data.model_dump(mode="json")},
    )
    return data


# ---- 編集・削除 ----
@router.patch("/messages/{message_id}", response_model=schemas.MessagePublic)
async def edit_message(
    message_id: int,
    payload: schemas.MessageUpdate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    msg = db.get(models.Message, message_id)
    if msg is None or msg.is_deleted:
        raise HTTPException(status_code=404, detail="メッセージが見つかりません")
    if msg.author_id != current.id:
        raise HTTPException(status_code=403, detail="自分のメッセージのみ編集できます")
    msg.content = payload.content
    msg.edited_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(msg)
    data = services.serialize_message(db, msg)
    await manager.send_to_users(
        _resolve_targets(db, msg),
        {"type": "message_updated", "message": data.model_dump(mode="json")},
    )
    return data


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    msg = db.get(models.Message, message_id)
    if msg is None or msg.is_deleted:
        raise HTTPException(status_code=404, detail="メッセージが見つかりません")

    can_delete = msg.author_id == current.id
    # チャンネルの場合は admin/moderator も削除可能
    if not can_delete and msg.channel_id is not None:
        channel = db.get(models.Channel, msg.channel_id)
        if channel:
            member = services.get_membership(db, channel.server_id, current.id)
            if member and member.role in {"admin", "moderator"}:
                can_delete = True
    if not can_delete:
        raise HTTPException(status_code=403, detail="削除する権限がありません")

    msg.is_deleted = True
    msg.content = ""
    db.commit()
    await manager.send_to_users(
        _resolve_targets(db, msg),
        {"type": "message_deleted", "message_id": message_id},
    )
    return {"ok": True}


# ---- リアクション ----
@router.post("/messages/{message_id}/reactions")
async def add_reaction(
    message_id: int,
    payload: schemas.ReactionCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    msg = db.get(models.Message, message_id)
    if msg is None or msg.is_deleted:
        raise HTTPException(status_code=404, detail="メッセージが見つかりません")
    existing = db.scalar(
        select(models.Reaction).where(
            models.Reaction.message_id == message_id,
            models.Reaction.user_id == current.id,
            models.Reaction.emoji == payload.emoji,
        )
    )
    if existing is None:
        db.add(
            models.Reaction(
                message_id=message_id, user_id=current.id, emoji=payload.emoji
            )
        )
        db.commit()
    db.refresh(msg)
    data = services.serialize_message(db, msg)
    await manager.send_to_users(
        _resolve_targets(db, msg),
        {"type": "message_updated", "message": data.model_dump(mode="json")},
    )
    return data


@router.delete("/messages/{message_id}/reactions/{emoji}")
async def remove_reaction(
    message_id: int,
    emoji: str,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    msg = db.get(models.Message, message_id)
    if msg is None:
        raise HTTPException(status_code=404, detail="メッセージが見つかりません")
    reaction = db.scalar(
        select(models.Reaction).where(
            models.Reaction.message_id == message_id,
            models.Reaction.user_id == current.id,
            models.Reaction.emoji == emoji,
        )
    )
    if reaction:
        db.delete(reaction)
        db.commit()
    db.refresh(msg)
    data = services.serialize_message(db, msg)
    await manager.send_to_users(
        _resolve_targets(db, msg),
        {"type": "message_updated", "message": data.model_dump(mode="json")},
    )
    return data


def _attach(
    db: Session, message_id: int, attachment_ids: list[int], user_id: int
) -> None:
    """事前アップロード済み添付ファイルをメッセージに紐付ける。"""
    for aid in attachment_ids:
        att = db.get(models.Attachment, aid)
        # 未紐付け かつ アップロード者本人のものだけ紐付け可能
        if att and att.message_id is None and att.uploader_id == user_id:
            att.message_id = message_id
