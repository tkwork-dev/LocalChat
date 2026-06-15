"""ユーザー・プロフィール関連エンドポイント。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=list[schemas.UserPublic])
def list_users(
    db: Session = Depends(get_db),
    _: models.User = Depends(get_current_user),
):
    users = db.scalars(select(models.User).where(models.User.is_active)).all()
    return [schemas.UserPublic.model_validate(u) for u in users]


@router.patch("/me", response_model=schemas.UserPublic)
def update_profile(
    payload: schemas.ProfileUpdate,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    if payload.display_name is not None:
        current.display_name = payload.display_name
    if payload.avatar_url is not None:
        current.avatar_url = payload.avatar_url
    if payload.status_message is not None:
        current.status_message = payload.status_message
    db.commit()
    db.refresh(current)
    return schemas.UserPublic.model_validate(current)
