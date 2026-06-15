"""認証関連ユーティリティ。

外部依存（bcrypt/jose等）を避け、Python標準ライブラリのみで
パスワードハッシュ化とトークン署名を実装する。完全オフライン環境向け。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from .config import settings

_PBKDF2_ITERATIONS = 200_000
_HASH_ALGO = "sha256"


def hash_password(password: str) -> str:
    """PBKDF2-HMAC-SHA256 でパスワードをハッシュ化する。"""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac(
        _HASH_ALGO, password.encode("utf-8"), salt, _PBKDF2_ITERATIONS
    )
    return f"pbkdf2_{_HASH_ALGO}${_PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """保存済みハッシュとパスワードを照合する。"""
    try:
        _algo, iterations, salt_hex, hash_hex = stored.split("$")
        iterations = int(iterations)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
        dk = hashlib.pbkdf2_hmac(
            _HASH_ALGO, password.encode("utf-8"), salt, iterations
        )
        return hmac.compare_digest(dk, expected)
    except (ValueError, AttributeError):
        return False


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_access_token(user_id: int) -> str:
    """HMAC-SHA256 署名付きトークンを生成する（自己完結・オフライン）。"""
    expire = int(time.time()) + settings.TOKEN_EXPIRE_MINUTES * 60
    payload = {"sub": user_id, "exp": expire}
    payload_b = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    payload_enc = _b64url_encode(payload_b)
    signature = hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        payload_enc.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{payload_enc}.{_b64url_encode(signature)}"


def decode_access_token(token: str) -> int | None:
    """トークンを検証し、ユーザーIDを返す。無効なら None。"""
    try:
        payload_enc, sig_enc = token.split(".")
    except (ValueError, AttributeError):
        return None

    expected_sig = hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        payload_enc.encode("ascii"),
        hashlib.sha256,
    ).digest()
    try:
        actual_sig = _b64url_decode(sig_enc)
    except (ValueError, Exception):
        return None
    if not hmac.compare_digest(expected_sig, actual_sig):
        return None

    try:
        payload = json.loads(_b64url_decode(payload_enc))
    except (ValueError, Exception):
        return None

    if payload.get("exp", 0) < int(time.time()):
        return None
    return payload.get("sub")
