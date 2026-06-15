"""サーバー（ワークスペース）・チャンネル・メンバー管理エンドポイント。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas, services
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/api/servers", tags=["servers"])


@router.get("", response_model=list[schemas.ServerPublic])
def list_my_servers(
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """自分が所属するサーバー一覧。"""
    server_ids = db.scalars(
        select(models.ServerMember.server_id).where(
            models.ServerMember.user_id == current.id
        )
    ).all()
    if not server_ids:
        return []
    servers = db.scalars(
        select(models.Server).where(models.Server.id.in_(server_ids))
    ).all()
    return [schemas.ServerPublic.model_validate(s) for s in servers]


@router.post("", response_model=schemas.ServerPublic, status_code=201)
def create_server(
    payload: schemas.ServerCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    server = models.Server(name=payload.name, owner_id=current.id)
    db.add(server)
    db.flush()
    # 作成者を admin として追加
    db.add(
        models.ServerMember(server_id=server.id, user_id=current.id, role="admin")
    )
    # 既定の general チャンネルを作成
    db.add(models.Channel(server_id=server.id, name="general", topic="一般チャンネル"))
    db.commit()
    db.refresh(server)
    return schemas.ServerPublic.model_validate(server)


@router.get("/{server_id}/channels", response_model=list[schemas.ChannelPublic])
def list_channels(
    server_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    services.require_membership(db, server_id, current.id)
    channels = db.scalars(
        select(models.Channel)
        .where(models.Channel.server_id == server_id)
        .order_by(models.Channel.position, models.Channel.id)
    ).all()
    return [schemas.ChannelPublic.model_validate(c) for c in channels]


@router.post(
    "/{server_id}/channels", response_model=schemas.ChannelPublic, status_code=201
)
def create_channel(
    server_id: int,
    payload: schemas.ChannelCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    # チャンネル作成は admin / moderator のみ
    services.require_role(db, server_id, current.id, {"admin", "moderator"})
    if payload.type != "text":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="現在はテキストチャンネルのみ対応しています（ボイス非対応）",
        )
    channel = models.Channel(
        server_id=server_id, name=payload.name, topic=payload.topic, type="text"
    )
    db.add(channel)
    db.commit()
    db.refresh(channel)
    return schemas.ChannelPublic.model_validate(channel)


@router.get("/{server_id}/members", response_model=list[schemas.MemberPublic])
def list_members(
    server_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    services.require_membership(db, server_id, current.id)
    members = db.scalars(
        select(models.ServerMember).where(models.ServerMember.server_id == server_id)
    ).all()
    result = []
    for m in members:
        user = db.get(models.User, m.user_id)
        if user:
            result.append(
                schemas.MemberPublic(
                    user=schemas.UserPublic.model_validate(user), role=m.role
                )
            )
    return result


@router.post("/{server_id}/join", response_model=schemas.ServerPublic)
def join_server(
    server_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """サーバー参加は招待コード経由のみ。直接参加は許可しない。"""
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="サーバーへの参加には招待コードが必要です",
    )


class _RoleUpdate(BaseModel):
    role: str


@router.patch("/{server_id}/members/{user_id}/role")
def update_member_role(
    server_id: int,
    user_id: int,
    payload: _RoleUpdate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """メンバーのロールを変更する（admin のみ）。"""
    services.require_role(db, server_id, current.id, {"admin"})
    if payload.role not in {"admin", "moderator", "member"}:
        raise HTTPException(status_code=400, detail="不正なロールです")
    member = services.get_membership(db, server_id, user_id)
    if member is None:
        raise HTTPException(status_code=404, detail="メンバーが見つかりません")
    member.role = payload.role
    db.commit()
    return {"ok": True, "role": payload.role}


@router.delete("/{server_id}/members/{user_id}", status_code=200)
def kick_member(
    server_id: int,
    user_id: int,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    """メンバーをサーバーから追放（キック）する（admin のみ）。"""
    services.require_role(db, server_id, current.id, {"admin"})

    server = db.get(models.Server, server_id)
    if server is None:
        raise HTTPException(status_code=404, detail="サーバーが見つかりません")

    # 自分自身はキックできない（退出は別操作）
    if user_id == current.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="自分自身をキックすることはできません",
        )
    # サーバーオーナーはキックできない
    if user_id == server.owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="サーバーオーナーをキックすることはできません",
        )

    member = services.get_membership(db, server_id, user_id)
    if member is None:
        raise HTTPException(status_code=404, detail="メンバーが見つかりません")

    db.delete(member)
    # このサーバーのチャンネルに対する既読状態も削除
    channel_ids = db.scalars(
        select(models.Channel.id).where(models.Channel.server_id == server_id)
    ).all()
    if channel_ids:
        read_states = db.scalars(
            select(models.ReadState).where(
                models.ReadState.user_id == user_id,
                models.ReadState.channel_id.in_(channel_ids),
            )
        ).all()
        for rs in read_states:
            db.delete(rs)
    db.commit()
    return {"ok": True}
