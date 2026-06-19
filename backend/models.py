"""SQLAlchemy ORM モデル定義。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _now() -> datetime:
    from .config import settings
    return datetime.now(timezone(timedelta(hours=settings.TZ_OFFSET_HOURS)))


class User(Base):
    """ユーザー（社内従業員）。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(255))
    avatar_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status_message: Mapped[str | None] = mapped_column(String(140), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Server(Base):
    """サーバー（ワークスペース）。部署・プロジェクト単位のグループ。"""

    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    icon_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    channels: Mapped[list["Channel"]] = relationship(
        back_populates="server", cascade="all, delete-orphan"
    )
    members: Mapped[list["ServerMember"]] = relationship(
        back_populates="server", cascade="all, delete-orphan"
    )


class ServerMember(Base):
    """サーバー所属メンバーとロール（権限）。"""

    __tablename__ = "server_members"
    __table_args__ = (UniqueConstraint("server_id", "user_id", name="uq_server_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    # ロール: admin / moderator / member
    role: Mapped[str] = mapped_column(String(20), default="member")
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    server: Mapped["Server"] = relationship(back_populates="members")


class ServerInvite(Base):
    """サーバー招待コード。管理者/モデレーターが発行し、保有者のみ参加可能。"""

    __tablename__ = "server_invites"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id"), index=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    # 最大使用回数（None で無制限）
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    uses: Mapped[int] = mapped_column(Integer, default=0)
    # 有効期限（None で無期限）
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Channel(Base):
    """テキストチャンネル。"""

    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id"))
    name: Mapped[str] = mapped_column(String(100))
    topic: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # type: text （ボイスは現フェーズ非対応）
    type: Mapped[str] = mapped_column(String(20), default="text")
    position: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    server: Mapped["Server"] = relationship(back_populates="channels")


class DMChannel(Base):
    """ダイレクトメッセージ用チャンネル（1対1 / グループ）。"""

    __tablename__ = "dm_channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    is_group: Mapped[bool] = mapped_column(Boolean, default=False)
    name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class DMMember(Base):
    """DMチャンネルの参加者。"""

    __tablename__ = "dm_members"
    __table_args__ = (UniqueConstraint("dm_channel_id", "user_id", name="uq_dm_user"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    dm_channel_id: Mapped[int] = mapped_column(ForeignKey("dm_channels.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))


class Message(Base):
    """メッセージ。テキストチャンネルまたはDMチャンネルに属する。"""

    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("channels.id"), nullable=True, index=True
    )
    dm_channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("dm_channels.id"), nullable=True, index=True
    )
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    content: Mapped[str] = mapped_column(Text, default="")
    # スレッド返信の親メッセージID
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id"), nullable=True, index=True
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, index=True)


class Reaction(Base):
    """絵文字リアクション。"""

    __tablename__ = "reactions"
    __table_args__ = (
        UniqueConstraint("message_id", "user_id", "emoji", name="uq_reaction"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    emoji: Mapped[str] = mapped_column(String(50))


class Attachment(Base):
    """メッセージ添付ファイル。社内サーバーのローカルパスに保存。"""

    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("messages.id"), nullable=True, index=True
    )
    uploader_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    filename: Mapped[str] = mapped_column(String(255))
    stored_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(120))
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class ReadState(Base):
    """既読状態。未読バッジ算出に利用。"""

    __tablename__ = "read_states"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "channel_id", "dm_channel_id", name="uq_read_state"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("channels.id"), nullable=True
    )
    dm_channel_id: Mapped[int | None] = mapped_column(
        ForeignKey("dm_channels.id"), nullable=True
    )
    last_read_message_id: Mapped[int] = mapped_column(Integer, default=0)
