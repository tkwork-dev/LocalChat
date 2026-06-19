# LocalChat コーディングガイド

## 基本方針

- **外部依存は最小限**: 標準ライブラリで実現できるものは標準ライブラリを使う
- **オフライン前提**: CDN・外部API呼び出し禁止
- **シンプルさ優先**: 過度な抽象化を避け、読みやすさを重視する

## バックエンド（Python / FastAPI）

### ファイル構成ルール

| ファイル | 役割 |
|---|---|
| `routers/*.py` | エンドポイント定義（ビジネスロジックは薄く） |
| `services.py` | 共通ビジネスロジック（権限判定など） |
| `models.py` | SQLAlchemy ORMモデル |
| `schemas.py` | Pydantic 入出力スキーマ |
| `security.py` | 認証・暗号化ユーティリティ |

### 命名規則

```python:naming_example.py
# 関数名: snake_case
def create_channel_message():
    pass

# クラス名: PascalCase
class MessageCreate(BaseModel):
    content: str

# 定数: UPPER_SNAKE_CASE
MAX_UPLOAD_SIZE = 50 * 1024 * 1024
```

### エラーハンドリング

```python:error_example.py
# HTTPExceptionを使い、日本語メッセージを返す
from fastapi import HTTPException

def require_membership(db, server_id, user_id):
    member = get_member(db, server_id, user_id)
    if member is None:
        raise HTTPException(
            status_code=403,
            detail="このサーバーのメンバーではありません"
        )
```

## フロントエンド（Vanilla JS）

### スタイルガイド

- フレームワーク不使用（React/Vue等は使わない）
- DOM操作は `$()` ヘルパ関数経由
- 状態は単一の `state` オブジェクトで管理
- CSSカスタムプロパティでテーマ切替対応

### イベント委譲パターン

```javascript:event_delegation.js
// 動的に生成される要素にはイベント委譲を使う
chatArea.addEventListener("click", (e) => {
  const btn = e.target.closest(".some-button");
  if (!btn) return;
  // 処理
});
```

### Markdown記法

チャットメッセージでは以下の記法が使える:

- `**太字**` → **太字**
- `*斜体*` → *斜体*
- `` `コード` `` → `コード`
- `~~取り消し~~` → ~~取り消し~~
- `@ユーザー名` → メンション通知

> コードブロックでは ` ```言語名:ファイル名 ` でファイル名が表示される

## コミットメッセージ

```
feat: 新機能の追加
fix: バグ修正
docs: ドキュメント更新
refactor: リファクタリング（機能変更なし）
style: フォーマット修正
```

## セキュリティチェックリスト

- [ ] ユーザー入力は必ずエスケープ（XSS対策）
- [ ] SQLはSQLAlchemy経由（SQLi対策）
- [ ] ファイルアップロードはサイズ制限あり
- [ ] トークンはHMAC-SHA256で署名
- [ ] パスワードはPBKDF2-SHA256でハッシュ化
