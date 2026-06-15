"""ダイレクトメッセージ（DM）関連エンドポイント。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas, services
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/api/dms", tags=["dms"])


def _serialize_dm(db: Session, dm: models.DMChannel) -> schemas.DMChannelPublic:
    member_ids = services.dm_member_ids(db, dm.id)
    users = db.scalars(
        select(models.User).where(models.User.id.in_(member_ids))
    ).all()
    return schemas.DMChannelPublic(
        id=dm.id,
        is_group=dm.is_group,
        name=dm.name,
        members=[schemas.UserPublic.model_validate(u) for u in users],
    )


@router.get("", response_model=list[schemas.DMChannelPublic])
def list_dms(
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    dm_ids = db.scalars(
        select(models.DMMember.dm_channel_id).where(
            models.DMMember.user_id == current.id
        )
    ).all()
    if not dm_ids:
        return []
    dms = db.scalars(
        select(models.DMChannel).where(models.DMChannel.id.in_(dm_ids))
    ).all()
    return [_serialize_dm(db, dm) for dm in dms]


@router.post("", response_model=schemas.DMChannelPublic, status_code=201)
def create_dm(
    payload: schemas.DMCreate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    # 参加者（自分を含む重複なしの集合）
    member_ids = sorted(set(payload.user_ids) | {current.id})
    if len(member_ids) < 2:
        raise HTTPException(status_code=400, detail="相手を指定してください")

    # 対象ユーザーの存在確認
    found = db.scalars(
        select(models.User.id).where(models.User.id.in_(member_ids))
    ).all()
    if len(found) != len(member_ids):
        raise HTTPException(status_code=400, detail="存在しないユーザーが含まれています")

    is_group = len(member_ids) > 2

    # 1対1の既存DMがあれば再利用する
    if not is_group:
        existing = _find_direct_dm(db, member_ids)
        if existing is not None:
            return _serialize_dm(db, existing)

    dm = models.DMChannel(is_group=is_group, name=payload.name)
    db.add(dm)
    db.flush()
    for uid in member_ids:
        db.add(models.DMMember(dm_channel_id=dm.id, user_id=uid))
    db.commit()
    db.refresh(dm)
    return _serialize_dm(db, dm)


def _find_direct_dm(db: Session, member_ids: list[int]) -> models.DMChannel | None:
    """指定2名の1対1DMを検索する。"""
    candidate_ids = db.scalars(
        select(models.DMMember.dm_channel_id).where(
            models.DMMember.user_id == member_ids[0]
        )
    ).all()
    for cid in candidate_ids:
        dm = db.get(models.DMChannel, cid)
        if dm and not dm.is_group:
            if set(services.dm_member_ids(db, cid)) == set(member_ids):
                return dm
    return None
