"""プライベートネットワーク限定アクセス制御（ASGIミドルウェア）。

要件定義書の「完全閉域網（社内イントラネットのみ）」を担保するため、
クライアントのIPアドレスがプライベート範囲（社内LAN）でない場合は
HTTP/WebSocket ともにアクセスを拒否する。

グローバルIP経由のアクセスを、ネットワーク機器の設定に依存せず
アプリ側でも確実にブロックするための多層防御の一つ。
"""
from __future__ import annotations

import ipaddress
from collections.abc import Iterable

# 既定で許可するネットワーク（ループバック・リンクローカル・RFC1918私設・ULA）
DEFAULT_PRIVATE_CIDRS = [
    "127.0.0.0/8",      # IPv4 ループバック
    "::1/128",          # IPv6 ループバック
    "10.0.0.0/8",       # 私設(クラスA)
    "172.16.0.0/12",    # 私設(クラスB)
    "192.168.0.0/16",   # 私設(クラスC)
    "169.254.0.0/16",   # IPv4 リンクローカル
    "fe80::/10",        # IPv6 リンクローカル
    "fc00::/7",         # IPv6 ユニークローカル(ULA)
]


def parse_networks(cidrs: Iterable[str]) -> list[ipaddress._BaseNetwork]:
    """CIDR文字列のリストをネットワークオブジェクトへ変換する。"""
    networks: list[ipaddress._BaseNetwork] = []
    for c in cidrs:
        c = c.strip()
        if not c:
            continue
        try:
            networks.append(ipaddress.ip_network(c, strict=False))
        except ValueError:
            # 不正なCIDRは無視（誤設定でアクセス全許可にしないため）
            continue
    return networks


def ip_is_allowed(ip_str: str, networks: list[ipaddress._BaseNetwork]) -> bool:
    """IPアドレスが許可ネットワークのいずれかに属するか判定する。"""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    # IPv4射影IPv6 (::ffff:192.168.0.1) はIPv4として評価
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return any(ip in net for net in networks)


class PrivateNetworkGuard:
    """プライベートIP以外からのアクセスを拒否するASGIミドルウェア。"""

    def __init__(
        self,
        app,
        networks: list[ipaddress._BaseNetwork],
        trust_forwarded: bool = False,
    ) -> None:
        self.app = app
        self.networks = networks
        self.trust_forwarded = trust_forwarded

    def _client_ip(self, scope) -> str | None:
        # リバースプロキシ配下のときのみ X-Forwarded-For を信頼（既定は無効）
        if self.trust_forwarded:
            for name, value in scope.get("headers", []):
                if name == b"x-forwarded-for":
                    first = value.decode("latin1").split(",")[0].strip()
                    if first:
                        return first
        client = scope.get("client")
        if client:
            return client[0]
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            ip = self._client_ip(scope)
            # IPが取得できない、または許可範囲外なら拒否
            if ip is None or not ip_is_allowed(ip, self.networks):
                await self._reject(scope, send)
                return
        await self.app(scope, receive, send)

    async def _reject(self, scope, send) -> None:
        if scope["type"] == "websocket":
            # ハンドシェイク前に拒否
            await send({"type": "websocket.close", "code": 4403})
            return
        body = b'{"detail":"\xe7\xa4\xbe\xe5\x86\x85\xe3\x83\x8d\xe3\x83\x83' \
               b'\xe3\x83\x88\xe3\x83\xaf\xe3\x83\xbc\xe3\x82\xaf\xe5\xa4\x96' \
               b'\xe3\x81\x8b\xe3\x82\x89\xe3\x81\xaf\xe5\x88\xa9\xe7\x94\xa8' \
               b'\xe3\x81\xa7\xe3\x81\x8d\xe3\x81\xbe\xe3\x81\x9b\xe3\x82\x93"}'
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode()),
            ],
        })
        await send({"type": "http.response.body", "body": body})
