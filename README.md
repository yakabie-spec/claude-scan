# 書類スキャンアプリ

スマホのカメラで書類を撮影 → Claude が OCR・ファイル名生成・保存先フォルダ提案 → 承認すると PDF として Dropbox に保存されるアプリです。

ビルド不要の単一ページ Web アプリ（HTML + JS）です。HTTPS でホスティングすればスマホのブラウザからそのまま使えます。

## 使い方の流れ

1. **📷 スキャン開始** ボタンでカメラが起動（書類の輪郭を緑枠で自動検出・撮影後に台形補正）
2. 複数ページある場合は **＋ページ追加** で続けて撮影
3. 大カテゴリを選択（**00 仕事** / **01 Private**）
4. Claude が画像を OCR し、`doc_rules.json` のネーミングルールと実際の Dropbox フォルダ構成をもとに **ファイル名＋保存先フォルダを提案**
5. **✅ 承認して保存** → PDF 化して Dropbox にアップロード
6. 提案がフィットしない場合は **📁 フォルダを変更する** から階層をたどって選択、または **＋新規フォルダ** を作成してから保存

## セットアップ

### 1. Dropbox アプリの作成（初回のみ）

1. [Dropbox App Console](https://www.dropbox.com/developers/apps) → **Create app**
2. **Scoped access** → **Full Dropbox** を選択し、アプリ名を付けて作成
3. **Permissions** タブで以下にチェックして Submit:
   - `files.metadata.read`（フォルダ一覧の取得）
   - `files.content.write`（PDF アップロード・フォルダ作成）
4. **Settings** タブの **OAuth 2 → Redirect URIs** に、このアプリをホスティングする URL（例: `https://<ユーザー名>.github.io/test-grading/doc-scan-app/`）を追加
5. **App key** を控える

### 2. Anthropic API キーの取得（初回のみ）

[Claude Console](https://platform.claude.com/) で API キーを発行します。

### 3. ホスティング

カメラ（getUserMedia）の制約により **HTTPS が必須**です（`localhost` は例外）。

- 簡単な方法: このリポジトリで GitHub Pages を有効化 → `https://.../doc-scan-app/` にアクセス
- ローカル確認: `cd doc-scan-app && python3 -m http.server 8000` → `http://localhost:8000`

### 4. アプリ内の設定

アプリ右上の **⚙️ 設定** から:

1. Anthropic API キーを入力
2. Dropbox App key を入力して **保存**
3. **🔗 Dropbox と接続する** → Dropbox の認可画面で許可

設定・トークンはブラウザの localStorage に保存されます（個人利用前提）。

## ファイル構成

| ファイル | 説明 |
|---|---|
| `index.html` | 画面定義（ホーム / カメラ / プレビュー / カテゴリ / 提案 / フォルダ選択 / 設定） |
| `app.js` | 全ロジック（カメラ・輪郭検出・Claude API・Dropbox API・PDF 生成） |
| `styles.css` | スタイル |
| `doc_rules.json` | ネーミングルール（リポジトリ直下のものと同内容。更新時は両方を同期） |

## 使用ライブラリ・API

- [jscanify](https://github.com/ColonelParrot/jscanify) + OpenCV.js — 書類輪郭の検出と台形補正（CDN）
- [jsPDF](https://github.com/parallax/jsPDF) — 画像 → PDF 変換（CDN）
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript)（`claude-opus-4-8`）— OCR・命名・フォルダ提案（structured outputs で JSON 取得）
- Dropbox API v2 — OAuth 2.0 PKCE / `list_folder` / `create_folder_v2` / `upload`

## 注意事項

- OpenCV.js（約 10MB）を CDN から読み込むため、初回アクセス時は少し時間がかかります
- 輪郭が検出できない場合は元画像をそのまま使用します（プレビューに表示されます）
- Claude へはスキャン画像（最大 3 ページ）と選択カテゴリ配下のフォルダ一覧（深さ 2、最大 350 件）を送信します
- ファイル名・パスは NFC 正規化してアップロードします（Dropbox の仕様）
- 同名ファイルが存在する場合は Dropbox 側で自動リネームされます（`(1)` 付与）
