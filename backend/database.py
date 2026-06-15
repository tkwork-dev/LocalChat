"""データベース接続（SQLAlchemy）。

外部クラウドDBは使用せず、社内オンプレミスのローカルSQLiteを利用する。
"""
from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

# SQLite を複数スレッドから利用するため check_same_thread を無効化
_connect_args = {}
if settings.DATABASE_URL.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}

engine = create_engine(
    settings.DATABASE_URL,
    connect_args=_connect_args,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """全ORMモデルの基底クラス。"""


def get_db() -> Generator[Session, None, None]:
    """リクエストごとのDBセッションを供給する依存性。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """テーブルを作成する（存在しない場合のみ）。"""
    # モデルをインポートしてメタデータに登録する
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
