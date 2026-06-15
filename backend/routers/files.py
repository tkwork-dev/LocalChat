"""ファイルアップロード・ダウンロード。

外部のCDNやクラウドストレージは一切利用せず、社内サーバーの
ローカルパス（UPLOAD_DIR）に保存し、ローカル経由で配信する。
"""
from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import settings
from ..database import get_db
from ..deps import get_current_user
from ..security import decode_access_token

router = APIRouter(prefix="/api/files", tags=["files"])


@router.post("", response_model=schemas.AttachmentPublic, status_code=201)
async def upload_file(
    file: UploadFile,
    db: Session = Depends(get_db),
    current: models.User = Depends(get_current_user),
):
    contents = await file.read()
    if len(contents) > settings.MAX_UPLOAD_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"ファイルサイズが上限（{settings.MAX_UPLOAD_SIZE} バイト）を超えています",
        )

    # 保存名はUUIDで衝突回避。元の拡張子のみ保持。
    suffix = Path(file.filename or "").suffix
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    dest = Path(settings.UPLOAD_DIR) / stored_name
    dest.write_bytes(contents)

    att = models.Attachment(
        message_id=None,
        uploader_id=current.id,
        filename=file.filename or stored_name,
        stored_name=stored_name,
        content_type=file.content_type or "application/octet-stream",
        size=len(contents),
    )
    db.add(att)
    db.commit()
    db.refresh(att)
    return schemas.AttachmentPublic.model_validate(att)


@router.get("/{attachment_id}")
def download_file(
    attachment_id: int,
    token: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    # <img> 等から参照できるよう、クエリパラメータのトークンで認証する
    if not token or decode_access_token(token) is None:
        raise HTTPException(status_code=401, detail="認証が必要です")
    att = db.get(models.Attachment, attachment_id)
    if att is None:
        raise HTTPException(status_code=404, detail="ファイルが見つかりません")
    path = Path(settings.UPLOAD_DIR) / att.stored_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="ファイル実体が存在しません")
    return FileResponse(
        path, media_type=att.content_type, filename=att.filename
    )
