"""自己署名TLS証明書の生成スクリプト（社内オフライン環境向け）。

uvicorn が読み込める PEM 形式の証明書（certs/server.crt）と
秘密鍵（certs/server.key）を生成する。localhost / 127.0.0.1 に加え、
この端末のホスト名・LAN内IPv4 を SAN へ自動登録するため、他のPCからも
WSS（暗号化WebSocket）で接続できる。

使い方:
    python scripts/gen_cert.py

なお、`.env` で TLS を有効化していれば、サーバー起動時にも自動で生成・更新されるため
通常このスクリプトを手動実行する必要はない（TLS_AUTO_GENERATE=true が既定）。
"""
from __future__ import annotations

import sys
from pathlib import Path

# backend パッケージを import できるようにプロジェクトルートをパスへ追加
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.tls import generate_self_signed  # noqa: E402


def main() -> None:
    cert_path = Path("certs/server.crt")
    key_path = Path("certs/server.key")
    labels = generate_self_signed(cert_path, key_path)

    print("証明書を生成しました:")
    print(f"  証明書: {cert_path.resolve()}")
    print(f"  秘密鍵: {key_path.resolve()}")
    print("  SAN:", ", ".join(labels))
    print()
    print(".env に以下を設定してサーバーを再起動してください:")
    print(f"  SSL_CERTFILE=./{cert_path.as_posix()}")
    print(f"  SSL_KEYFILE=./{key_path.as_posix()}")


if __name__ == "__main__":
    main()
