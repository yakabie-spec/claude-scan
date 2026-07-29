# claude-scan — Vercel デプロイ手順

Netlify の公開ファイル一式（完全静的サイト）です。サーバー関数はありません。
Anthropic API / Dropbox API はブラウザから直接呼ぶ方式なので、そのままVercelで動きます。

## デプロイ手順（GitHub 経由）
1. このフォルダを Git リポジトリにして GitHub へ push。
   git init && git add -A && git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/<あなた>/claude-scan.git
   git push -u origin main
2. Vercel ダッシュボード → Add New → Project → GitHub の claude-scan を Import。
   - Framework Preset: Other（自動検出でOK）。Build 設定は空のまま。Output は「.（ルート）」。
3. デプロイ完了 → https://claude-scan.vercel.app などで公開。

## 注意
- vendor/ に大きなライブラリ（opencv.js 8.6MB / ONNXランタイム約13MB）が含まれます。
  GitHub の1ファイル上限は100MBなので問題ありません。
- ローカル保存データ（設定・APIキー・Dropbox連携）はドメインごとに紐づくため、
  新しい *.vercel.app では初期状態になります。再設定してください。
