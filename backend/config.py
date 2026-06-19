"""アプリケーション設定。

完全オフライン運用を前提とし、社内環境に依存する値（IPアドレス・パス・
シークレット等）はハードコードせず、すべて環境変数から読み込む。
"""
from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv(path: str = ".env") -> None:
    """簡易 .env ローダ（外部依存を避けるため標準ライブラリのみで実装）。"""
    env_path = Path(path)
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # 既存の環境変数を優先（明示指定を上書きしない）
        os.environ.setdefault(key, value)


_load_dotenv()


class Settings:
    """環境変数から読み込む設定値。"""

    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))

    SECRET_KEY: str = os.getenv("SECRET_KEY", "dev-insecure-secret-change-me")
    TOKEN_EXPIRE_MINUTES: int = int(os.getenv("TOKEN_EXPIRE_MINUTES", "1440"))

    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./data/localchat.db")
    UPLOAD_DIR: str = os.getenv("UPLOAD_DIR", "./data/uploads")
    MAX_UPLOAD_SIZE: int = int(os.getenv("MAX_UPLOAD_SIZE", str(50 * 1024 * 1024)))

    SSL_CERTFILE: str = os.getenv("SSL_CERTFILE", "")
    SSL_KEYFILE: str = os.getenv("SSL_KEYFILE", "")

    # TLS証明書の自動生成・自動更新（自己署名のみ対象）
    TLS_AUTO_GENERATE: bool = os.getenv("TLS_AUTO_GENERATE", "true").lower() in ("1", "true", "yes")
    # 残り日数がこの値以下になったら自己署名証明書を再生成する
    TLS_RENEW_DAYS: int = int(os.getenv("TLS_RENEW_DAYS", "30"))

    # プライベートネットワーク限定アクセス（完全閉域網の担保）
    # true の場合、社内LAN（プライベートIP）以外からのアクセスを拒否する
    RESTRICT_TO_PRIVATE: bool = os.getenv("RESTRICT_TO_PRIVATE", "true").lower() in ("1", "true", "yes")
    # 許可するネットワーク（カンマ区切りCIDR）。空なら既定のプライベート範囲を使用
    ALLOWED_CIDRS: str = os.getenv("ALLOWED_CIDRS", "")
    # リバースプロキシ配下で X-Forwarded-For を信頼するか（既定: 無効）
    TRUST_FORWARDED_FOR: bool = os.getenv("TRUST_FORWARDED_FOR", "false").lower() in ("1", "true", "yes")

    # CORS 許可オリジン（カンマ区切り）。docs/ の図エラー検証ラボを別オリジン
    # （file:// や別ポート）で開く場合に必要。既定は "*"（Bearerトークン認証の
    # ため資格情報モードは使わず、社内LAN限定アクセスと併用する前提）。
    CORS_ALLOW_ORIGINS: str = os.getenv("CORS_ALLOW_ORIGINS", "*")

    # PlantUML レンダリング（任意）。社内に配置した plantuml.jar のパスを指定すると
    # サーバー側で図を描画する。未設定の場合はソース表示にフォールバックする。
    PLANTUML_JAR: str = os.getenv("PLANTUML_JAR", "")
    JAVA_BIN: str = os.getenv("JAVA_BIN", "java")

    # タイムゾーン（UTCからのオフセット時間）。日本なら 9、UTCなら 0。
    TZ_OFFSET_HOURS: int = int(os.getenv("TZ_OFFSET_HOURS", "9"))

    def ensure_dirs(self) -> None:
        """データ・アップロード用ディレクトリを作成する。"""
        Path(self.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
        # SQLite ファイルの親ディレクトリも作成
        if self.DATABASE_URL.startswith("sqlite:///"):
            db_path = self.DATABASE_URL.replace("sqlite:///", "", 1)
            parent = Path(db_path).parent
            if str(parent):
                parent.mkdir(parents=True, exist_ok=True)


settings = Settings()
