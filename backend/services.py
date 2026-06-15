"""ドメインサービス（権限判定・整形・通知対象解決などの共通処理）。"""
from __future__ import annotations

from collections import defaultdict

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, schemas


# ---- 権限・メンバーシップ ----
def get_membership(
    db: Session, server_id: int, user_id: int
) -> models.ServerMember | None:
    return db.scalar(
        select(models.ServerMember).where(
            models.ServerMember.server_id == server_id,
            models.ServerMember.user_id == user_id,
        )
    )


def require_membership(
    db: Session, server_id: int, user_id: int
) -> models.ServerMember:
    member = get_membership(db, server_id, user_id)
    if member is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このサーバーのメンバーではありません",
        )
    return member


def require_role(
    db: Session, server_id: int, user_id: int, roles: set[str]
) -> models.ServerMember:
    member = require_membership(db, server_id, user_id)
    if member.role not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="この操作を行う権限がありません",
        )
    return member


def channel_member_ids(db: Session, channel: models.Channel) -> list[int]:
    """テキストチャンネルの通知対象（サーバーメンバー全員）。"""
    rows = db.scalars(
        select(models.ServerMember.user_id).where(
            models.ServerMember.server_id == channel.server_id
        )
    ).all()
    return list(rows)


def dm_member_ids(db: Session, dm_channel_id: int) -> list[int]:
    rows = db.scalars(
        select(models.DMMember.user_id).where(
            models.DMMember.dm_channel_id == dm_channel_id
        )
    ).all()
    return list(rows)


def is_dm_member(db: Session, dm_channel_id: int, user_id: int) -> bool:
    return user_id in dm_member_ids(db, dm_channel_id)


# ---- メッセージ整形 ----
def serialize_message(db: Session, msg: models.Message) -> schemas.MessagePublic:
    author = db.get(models.User, msg.author_id)

    attachments = db.scalars(
        select(models.Attachment).where(models.Attachment.message_id == msg.id)
    ).all()

    reaction_rows = db.scalars(
        select(models.Reaction).where(models.Reaction.message_id == msg.id)
    ).all()
    grouped: dict[str, list[int]] = defaultdict(list)
    for r in reaction_rows:
        grouped[r.emoji].append(r.user_id)
    reactions = [
        schemas.ReactionPublic(emoji=emoji, count=len(uids), user_ids=uids)
        for emoji, uids in grouped.items()
    ]

    return schemas.MessagePublic(
        id=msg.id,
        channel_id=msg.channel_id,
        dm_channel_id=msg.dm_channel_id,
        author=schemas.UserPublic.model_validate(author),
        content="" if msg.is_deleted else msg.content,
        parent_id=msg.parent_id,
        is_deleted=msg.is_deleted,
        edited_at=msg.edited_at,
        created_at=msg.created_at,
        attachments=[schemas.AttachmentPublic.model_validate(a) for a in attachments],
        reactions=reactions,
    )
