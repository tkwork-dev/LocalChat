"""Pydantic スキーマ（リクエスト/レスポンスのデータ構造）。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---- 認証・ユーザー ----
class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=50)
    display_name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=4, max_length=200)


class UserLogin(BaseModel):
    username: str
    password: str


class UserPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    avatar_url: str | None = None
    status_message: str | None = None


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)
    avatar_url: str | None = Field(default=None, max_length=255)
    status_message: str | None = Field(default=None, max_length=140)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserPublic


# ---- サーバー（ワークスペース） ----
class ServerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ServerPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    icon_url: str | None = None
    owner_id: int


class MemberPublic(BaseModel):
    user: UserPublic
    role: str


# ---- 招待コード ----
class InviteCreate(BaseModel):
    # 最大使用回数（未指定=無制限）
    max_uses: int | None = Field(default=None, ge=1)
    # 有効期限（分。未指定=無期限）
    expires_in_minutes: int | None = Field(default=None, ge=1)


class InvitePublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    server_id: int
    code: str
    max_uses: int | None = None
    uses: int
    expires_at: datetime | None = None
    is_revoked: bool
    created_at: datetime


class InvitePreview(BaseModel):
    code: str
    server_id: int
    server_name: str
    already_member: bool


# ---- チャンネル ----
class ChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    topic: str | None = Field(default=None, max_length=255)
    type: str = "text"


class ChannelPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    server_id: int
    name: str
    topic: str | None = None
    type: str


# ---- メッセージ ----
class MessageCreate(BaseModel):
    content: str = Field(default="", max_length=4000)
    parent_id: int | None = None
    attachment_ids: list[int] = Field(default_factory=list)


class MessageUpdate(BaseModel):
    content: str = Field(max_length=4000)


class AttachmentPublic(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    content_type: str
    size: int


class ReactionPublic(BaseModel):
    emoji: str
    count: int
    user_ids: list[int]


class MessagePublic(BaseModel):
    id: int
    channel_id: int | None
    dm_channel_id: int | None
    author: UserPublic
    content: str
    parent_id: int | None
    is_deleted: bool
    edited_at: datetime | None
    created_at: datetime
    attachments: list[AttachmentPublic] = Field(default_factory=list)
    reactions: list[ReactionPublic] = Field(default_factory=list)


# ---- DM ----
class DMCreate(BaseModel):
    user_ids: list[int] = Field(min_length=1)
    name: str | None = None


class DMChannelPublic(BaseModel):
    id: int
    is_group: bool
    name: str | None
    members: list[UserPublic]


# ---- リアクション ----
class ReactionCreate(BaseModel):
    emoji: str = Field(min_length=1, max_length=50)
