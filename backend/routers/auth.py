"""認証関連エンドポイント（登録・ログイン）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=schemas.TokenResponse)
def register(payload: schemas.UserCreate, db: Session = Depends(get_db)):
    exists = db.scalar(
        select(models.User).where(models.User.username == payload.username)
    )
    if exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="そのユーザー名は既に使用されています",
        )
    user = models.User(
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    token = create_access_token(user.id)
    return schemas.TokenResponse(
        access_token=token, user=schemas.UserPublic.model_validate(user)
    )


@router.post("/login", response_model=schemas.TokenResponse)
def login(payload: schemas.UserLogin, db: Session = Depends(get_db)):
    user = db.scalar(
        select(models.User).where(models.User.username == payload.username)
    )
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="ユーザー名またはパスワードが正しくありません",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="このアカウントは無効化されています",
        )
    token = create_access_token(user.id)
    return schemas.TokenResponse(
        access_token=token, user=schemas.UserPublic.model_validate(user)
    )


@router.get("/me", response_model=schemas.UserPublic)
def me(current: models.User = Depends(get_current_user)):
    return schemas.UserPublic.model_validate(current)
