"""招待コード関連エンドポイント。

サーバーへの参加は招待コード方式とする。管理者/モデレーターが
コードを発行し、コードを持つユーザーのみが参加できる。
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas, services
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/api", tags=["invites"])

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 紛らわしい文字を除外


def _generate_code(db: Session, length: int = 8) -> str:
    """衝突しない招待コードを生成する。"""
    for _ in range(20):
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(length))
        exists = db.scalar(
            select(models.ServerInvite).where(models.ServerInvite.code == code)
        )
        if exists is None:
            return code
    raise HTTPException(status_code=500, detail="招待コードの生成に失敗しました")


def _is_valid(invite: models.ServerInvite) -> bool:
    """招待が現在有効かどうかを判定する。"""
    if invite.is_revoked:
        return False
    if invite.max_uses is not None and invite.uses >= invite.max_uses:
        return False
    if invite.expires_at is not None:
        expires = invite.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        if expires < datetime.now(timezone.utc):
            return False
    return True


@router.post("/servers/{server_id}/invites", response_model=schemas.InvitePublic, status_code=201)
def create_invite(
    server_id: int,
    payload: schemas.InviteCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    # 招待発行は admin / moderator のみ
    services.require_role(db, server_id, current.id, {"admin", "moderator"})

    expires_at = None
    if payload.expires_in_minutes:
        expires_at = datetime.now(timezone.utc) + timedelta(
            minutes=payload.expires_in_minutes
        )

    invite = models.ServerInvite(
        server_id=server_id,
        code=_generate_code(db),
        created_by=current.id,
        max_uses=payload.max_uses,
        expires_at=expires_at,
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return schemas.InvitePublic.model_validate(invite)


@router.get("/servers/{server_id}/invites", response_model=list[schemas.InvitePublic])
def list_invites(
    server_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    services.require_role(db, server_id, current.id, {"admin", "moderator"})
    invites = db.scalars(
        select(models.ServerInvite)
        .where(models.ServerInvite.server_id == server_id)
        .order_by(models.ServerInvite.id.desc())
    ).all()
    return [schemas.InvitePublic.model_validate(i) for i in invites]


@router.delete("/servers/{server_id}/invites/{invite_id}")
def revoke_invite(
    server_id: int,
    invite_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    services.require_role(db, server_id, current.id, {"admin", "moderator"})
    invite = db.get(models.ServerInvite, invite_id)
    if invite is None or invite.server_id != server_id:
        raise HTTPException(status_code=404, detail="招待が見つかりません")
    invite.is_revoked = True
    db.commit()
    return {"ok": True}


@router.get("/invites/{code}", response_model=schemas.InvitePreview)
def preview_invite(
    code: str,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """参加前に招待先サーバー情報を確認する。"""
    invite = db.scalar(
        select(models.ServerInvite).where(models.ServerInvite.code == code.upper())
    )
    if invite is None or not _is_valid(invite):
        raise HTTPException(status_code=404, detail="無効または期限切れの招待コードです")
    server = db.get(models.Server, invite.server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")
    already = services.get_membership(db, server.id, current.id) is not None
    return schemas.InvitePreview(
        code=invite.code,
        server_id=server.id,
        server_name=server.name,
        already_member=already,
    )


@router.post("/invites/{code}/accept", response_model=schemas.ServerPublic)
def accept_invite(
    code: str,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """招待コードを使ってサーバーに参加する。"""
    invite = db.scalar(
        select(models.ServerInvite).where(models.ServerInvite.code == code.upper())
    )
    if invite is None or not _is_valid(invite):
        raise HTTPException(status_code=404, detail="無効または期限切れの招待コードです")

    server = db.get(models.Server, invite.server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")

    # 既にメンバーなら使用回数を消費せずに返す
    if services.get_membership(db, server.id, current.id) is None:
        db.add(
            models.ServerMember(
                server_id=server.id, user_id=current.id, role="member"
            )
        )
        invite.uses += 1
        db.commit()
    return schemas.ServerPublic.model_validate(server)
