# LocalChat 環境構築手順書

`git clone` から起動・社内公開までの手順をまとめたガイドです。完全オフライン（閉域網）での
運用を前提としています。コマンド例は Windows（`cmd`）を基本に記載し、必要に応じて
macOS / Linux 向けを併記します。

---

## 1. 前提条件（事前に用意するもの）

| 項目 | 必須 | 用途・備考 |
|------|------|-----------|
| Python 3.11 以上 | 必須 | バックエンド実行環境。`python --version` で確認 |
| Git | 必須 | リポジトリの取得 |
| Java 11 以上（JRE/JDK） | 任意 | PlantUML 図をサーバー描画する場合のみ。ポータブルJREでも可 |
| `plantuml.jar` | 任意 | PlantUML 図を描画する場合のみ |

> Mermaid 図はブラウザ内描画のため Java は不要です。Java と `plantuml.jar` は
> **PlantUML をサーバー側で描画したい場合のみ**必要です。

> 閉域網で `pip install` ができない場合は、別環境で `pip download` してホイール（wheel）を
> 持ち込み、オフラインインストールしてください（手順は「7. オフライン環境での依存導入」を参照）。

---

## 2. リポジトリの取得（git clone）

```cmd
git clone https://github.com/tkwork-dev/LocalChat.git
cd LocalChat
```

---

## 3. Python 仮想環境の作成と有効化

プロジェクト専用の仮想環境を作成すると、他のPython環境を汚さずに済みます。

Windows（cmd）:

```cmd
python -m venv .venv
.venv\Scripts\activate
```

macOS / Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

> `.venv/` は `.gitignore` 済みのため、コミットされることはありません。

---

## 4. 依存パッケージのインストール

```cmd
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

インストールされる主なパッケージ:

- `fastapi` / `uvicorn` … Webサーバー・WebSocket
- `SQLAlchemy` … DBアクセス（SQLite）
- `python-multipart` … ファイルアップロード
- `pydantic` … 入出力スキーマ
- `cryptography` … TLS自己署名証明書の生成・自動更新（TLSを使わない場合は任意）

---

## 5. 環境変数の設定（.env）

サンプルをコピーして `.env` を作成します。

Windows（cmd）:

```cmd
copy .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

`.env` を開き、**最低限 `SECRET_KEY` を推測困難な値へ変更**してください。
ランダムな値は次のコマンドで生成できます。

```cmd
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

出力された文字列を `.env` の `SECRET_KEY` に設定します。

```dotenv
SECRET_KEY=ここに生成した値を貼り付け
PORT=8777
```

> `.env` は機密情報を含むため `.gitignore` 済みです。**絶対にコミットしないでください。**

主な設定項目（詳細は `.env.example` のコメントを参照）:

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `HOST` | `0.0.0.0` | 待ち受けホスト。特定の社内IPに絞ることも可 |
| `PORT` | `8000` | 待ち受けポート |
| `SECRET_KEY` | （要変更） | トークン署名用シークレット |
| `DATABASE_URL` | `sqlite:///./data/localchat.db` | DB格納先 |
| `UPLOAD_DIR` | `./data/uploads` | アップロード保存先 |
| `RESTRICT_TO_PRIVATE` | `true` | 社内LAN（プライベートIP）以外を拒否 |
| `SSL_CERTFILE` / `SSL_KEYFILE` | 空 | TLS証明書パス（設定すると HTTPS/WSS で起動） |
| `PLANTUML_JAR` | 空 | PlantUML描画用JARのパス（任意） |
| `JAVA_BIN` | `java` | Java実行ファイルのパス（任意） |

> `data/`（DB・アップロード）ディレクトリは起動時に自動作成されるため、手動作成は不要です。

---

## 6. 起動と動作確認

```cmd
python run.py
```

ブラウザで以下を開きます（TLS未設定時は HTTP）。

```
http://localhost:8777
```

> ポートは `.env` の `PORT` に合わせてください（`.env.example` の既定は 8000、
> 同梱の `.env` 例では 8777）。

初回利用者は画面の「新規登録」からアカウントを作成します。最初に作成した運用者が
サーバー（ワークスペース）を作り、招待コードを発行してメンバーを招待します。

停止するときは実行中のターミナルで `Ctrl + C` を押します。

---

## 7. オフライン環境での依存導入（閉域網向け・任意）

インターネット接続のある別端末で wheel を収集し、社内へ持ち込みます。

接続環境（収集側）:

```cmd
python -m pip download -r requirements.txt -d wheels
```

`wheels` フォルダを USB 等で閉域網の端末へコピーし、オフラインでインストールします。

閉域網（導入側）:

```cmd
python -m pip install --no-index --find-links wheels -r requirements.txt
```

---

## 8. TLS（HTTPS / WSS）の有効化（推奨・任意）

社内LAN内でも通信を暗号化する場合に設定します。設定すると WebSocket も自動で
`wss://` を使用します。

### 8-1. 自己署名証明書を使う（手軽）

`.env` で TLS を有効化していれば、**サーバー起動時に証明書を自動生成・自動更新**します
（既定 `TLS_AUTO_GENERATE=true`）。`.env` に証明書パスを設定するだけで構いません。

```dotenv
SSL_CERTFILE=./certs/server.crt
SSL_KEYFILE=./certs/server.key
```

手動で生成したい場合は次のスクリプトを使います（`localhost` / `127.0.0.1` に加え、
端末のホスト名・LAN内IPv4 を SAN へ自動登録します）。

```cmd
python -m pip install cryptography
python scripts/gen_cert.py
```

> `certs/` は秘密鍵を含むため `.gitignore` 済みです。各環境で生成してください。
> 自己署名のため初回アクセス時にブラウザが警告を表示します。社内では `certs/server.crt` を
> 各端末の「信頼されたルート証明機関」に取り込むと警告が出なくなります。

### 8-2. 社内認証局の正式な証明書を使う（推奨）

社内CAが発行した PEM 形式の証明書・秘密鍵を `certs/` に配置し、`.env` にパスを設定します。
正式な証明書は自動更新の対象外（上書きされません）です。

---

## 9. 社内ネットワークへの公開（任意）

### 9-1. Windows ファイアウォールの開放

他のPCから接続できるよう、社内ネットワーク（Domain/Private プロファイル）でのみ
ポートを許可します。Public（公衆網）では許可しません。

PowerShell を**管理者として実行**し、次を実行します（UACが自動で昇格します）。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\open_firewall.ps1 -Port 8777
```

実行後、同じネットワークの同僚がアクセスできるURL（`https://<このPCのIP>:8777`）が
一覧表示されます。

### 9-2. アクセス制限（閉域網の担保）

既定で `RESTRICT_TO_PRIVATE=true` のため、社内LAN（プライベートIP）以外からの
アクセスはアプリ側でも拒否されます。許可ネットワークを限定する場合は CIDR を指定します。

```dotenv
RESTRICT_TO_PRIVATE=true
ALLOWED_CIDRS=192.168.10.0/24,10.20.0.0/16
```

---

## 10. PlantUML 図のサーバー描画（任意）

`plantuml.jar` と Java は容量が大きく `.gitignore` で除外されているため、**各環境で配置**します。
（Mermaid 図はブラウザ内描画のため、この設定は不要です。）

1. `plantuml.jar`（最新版は Java 11 以上が必要）をプロジェクト配下に配置（例: `plantuml/`）
2. ポータブルJRE（Eclipse Temurin / Amazon Corretto などの zip 版）を展開（例: `runtime/`）
3. `.env` にパスを設定

```dotenv
PLANTUML_JAR=./plantuml/plantuml-asl-1.2026.6.jar
JAVA_BIN=./runtime/jdk-17.0.19+10-jre/bin/java.exe
```

> 未設定の場合、`plantuml` コードブロックはソースコードのまま表示されます（エラーにはなりません）。

---

## 11. データの保存先とバックアップ

| 種類 | 既定パス | 変更方法 |
|------|----------|----------|
| データベース | `./data/localchat.db` | `.env` の `DATABASE_URL` |
| アップロードファイル | `./data/uploads/` | `.env` の `UPLOAD_DIR` |

`data/` は `.gitignore` 済みです。バックアップは `data/` ディレクトリごと定期的に
社内NAS等へ退避してください（社内共有ストレージへ保存する場合は上記パスをマウント先に設定）。

---

## 12. トラブルシューティング

| 症状 | 原因・対処 |
|------|-----------|
| 起動時に `ModuleNotFoundError` | 仮想環境の有効化忘れ、または `pip install -r requirements.txt` 未実行 |
| ブラウザで接続できない | `PORT` の不一致、またはファイアウォール未開放（手順9参照） |
| 他PCから接続できない | ファイアウォール開放、`RESTRICT_TO_PRIVATE` / `ALLOWED_CIDRS` 設定、TLS時はSAN（IP）を確認 |
| ブラウザのTLS警告 | 自己署名証明書のため。`certs/server.crt` を信頼済みルートに取り込むか、社内CAの証明書を使用 |
| PlantUMLが画像にならない | `PLANTUML_JAR` 未設定、または Java が古い（`UnsupportedClassVersionError` は Java 11+ が必要） |
| ログインできない（再起動後） | `SECRET_KEY` を変更すると既存トークンは無効化されます。再ログインしてください |

---

## クイックスタート（最短手順のまとめ）

```cmd
git clone https://github.com/tkwork-dev/LocalChat.git
cd LocalChat
python -m venv .venv
.venv\Scripts\activate
python -m pip install -r requirements.txt
copy .env.example .env
:: .env を開いて SECRET_KEY を変更してから↓
python run.py
```

ブラウザで `http://localhost:8777`（`.env` の `PORT` に合わせる）を開いて「新規登録」へ。
