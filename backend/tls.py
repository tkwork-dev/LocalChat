"""自己署名TLS証明書の生成・自動更新ユーティリティ。

サーバー起動時に証明書の有効期限を確認し、未作成または期限が近い場合は
自動で再生成する。社内オフライン環境で証明書を手動管理する手間を省く。

安全策:
    自動再生成は「ファイルが存在しない」または「LocalChat が発行した
    自己署名証明書（発行者の組織名が 'LocalChat'）」の場合のみ行う。
    社内認証局などが発行した正式な証明書は上書きしない。

`cryptography` パッケージが未インストールの場合は何もしない（既存の
証明書ファイルがあればそれを使用する）。
"""
from __future__ import annotations

import datetime
import ipaddress
import socket
from pathlib import Path

ORG_NAME = "LocalChat"


def _local_ipv4_addresses() -> list[str]:
    """この端末のLAN内IPv4アドレスを収集する（外部へは送信しない）。"""
    addrs: set[str] = set()
    hostname = socket.gethostname()
    try:
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addrs.add(info[4][0])
    except socket.gaierror:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        addrs.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(addrs)


def generate_self_signed(cert_path: Path, key_path: Path) -> list[str]:
    """自己署名証明書と秘密鍵を生成し、SANラベルの一覧を返す。"""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    hostname = socket.gethostname()
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, hostname),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, ORG_NAME),
    ])

    dns_names = sorted({"localhost", hostname, hostname.lower()})
    ip_addrs = sorted({"127.0.0.1", "::1", *_local_ipv4_addresses()})

    san: list = [x509.DNSName(n) for n in dns_names]
    labels = [f"DNS:{n}" for n in dns_names]
    for ip in ip_addrs:
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(ip)))
            labels.append(f"IP:{ip}")
        except ValueError:
            continue

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return labels


def _inspect_cert(cert_path: Path):
    """既存証明書の (有効期限, 自己署名か) を返す。読めなければ (None, False)。"""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID

        data = cert_path.read_bytes()
        cert = x509.load_pem_x509_certificate(data)
        try:
            not_after = cert.not_valid_after_utc
        except AttributeError:  # 古い cryptography 互換
            not_after = cert.not_valid_after.replace(tzinfo=datetime.timezone.utc)
        # LocalChat 発行（自己署名）かどうかを発行者の組織名で判定
        is_ours = False
        try:
            orgs = cert.issuer.get_attributes_for_oid(NameOID.ORGANIZATION_NAME)
            is_ours = any(a.value == ORG_NAME for a in orgs)
        except Exception:
            is_ours = False
        return not_after, is_ours
    except Exception:
        return None, False


def ensure_cert(cert_file: str, key_file: str, renew_days: int = 30) -> bool:
    """必要に応じて証明書を生成・更新する。

    戻り値: 証明書と鍵が利用可能な状態なら True。
    """
    cert_path = Path(cert_file)
    key_path = Path(key_file)

    exists = cert_path.exists() and key_path.exists()
    not_after, is_ours = (_inspect_cert(cert_path) if cert_path.exists() else (None, False))

    need_generate = False
    reason = ""
    if not exists:
        need_generate = True
        reason = "証明書が見つからないため新規生成します"
    elif not_after is not None:
        now = datetime.datetime.now(datetime.timezone.utc)
        days_left = (not_after - now).days
        if days_left <= renew_days:
            if is_ours:
                need_generate = True
                reason = f"自己署名証明書の有効期限が近い（残り{days_left}日）ため自動更新します"
            else:
                # 正式な証明書は上書きしない（警告のみ）
                print(f"[TLS] 警告: 証明書の有効期限が近づいています（残り{days_left}日）。"
                      "正式な証明書のため自動更新はスキップしました。手動で更新してください。")

    if not need_generate:
        return exists

    try:
        labels = generate_self_signed(cert_path, key_path)
    except ImportError:
        print("[TLS] 証明書の自動生成には 'cryptography' が必要です。"
              "`python -m pip install cryptography` を実行するか、手動で証明書を配置してください。")
        return exists
    except Exception as e:  # 生成失敗時も起動は継続
        print(f"[TLS] 証明書の自動生成に失敗しました: {e}")
        return exists

    print(f"[TLS] {reason}")
    print(f"[TLS] 生成しました: {cert_path} / {key_path}")
    print(f"[TLS] SAN: {', '.join(labels)}")
    return True
