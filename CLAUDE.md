<!-- DevRelay Agreement v6 -->
See `rules/devrelay.md` for DevRelay rules.
<!-- /DevRelay Agreement -->

---

# mimamori-server

## サービス情報

| 項目 | 値 |
|------|-----|
| URL | https://mimamori-server.devrelay.io |
| Port | 9021 |
| DB | PostgreSQL `mimamori-server`（user: `mimamori-server_user`） |
| ディレクトリ | /home/devrelay/testflight/mimamori-server |
| GitHub | https://github.com/murata1215/mimamori-server（**public**） |

リポジトリは公開されている。コミットする内容が公開に耐えるかを常に確認すること
（除外の方針と理由は `doc/changelog.md` の 2026-07-17 GitHub公開 の項）。

## ホスティング構成

- **リバースプロキシ**: Caddy（`mimamori-server.devrelay.io` → `localhost:9021`）
- **バックエンド未起動時**: `placeholder/index.html` が自動表示される（Caddy handle_errors フォールバック）
- **開発方法**: ポート 9021 で dev サーバーを起動すれば自動的にプロキシが通る
- **静的サイト**: `placeholder/index.html` を書き換えるだけでサイト表示が変わる（サーバー不要）

## 環境変数

`.env` に設定済み:
- `DATABASE_URL` — PostgreSQL 接続文字列
- `PORT` — サービスのポート番号
- `JWT_SECRET` — JWT署名鍵（ローテーションすると全端末の再ペアリングが必要）

判定パラメータ・外部サービス連携は `doc/operations.md` を参照。

## ドキュメント

| 文書 | 内容 |
|------|------|
| `doc/api.md` | APIリファレンス |
| `doc/operations.md` | 運用・監視・トラブルシューティング |
| `doc/issues.md` | 課題管理 |
| `doc/changelog.md` | 変更履歴と設計判断の根拠 |
| `.devrelay-files/*-spec*.md` | プロダクト思想・サーバー/Flutter仕様（一次情報） |

## 開発

```bash
npm run migrate   # マイグレーション（冪等）
npm run dev       # 開発サーバー
npm run typecheck # 型チェック（本体 + tests。tests は別 tsconfig なので忘れずに）
npm test          # テスト（実DBを使う統合テストを含む）
```

## 新しいソース（センサー）を足すとき

`src/engine/sources.ts` に定義を足し、Webhook アダプタを書くだけ。
**判定エンジン・状態遷移・学習・通知を改修してはならない**（改修が必要になった時点で
アダプタ設計の失敗。spec 8）。Phase 2 で2ソース足して `events` の変更は0件だった。

## 実装上の絶対ルール

このサービスは命に関わる。以下は仕様の都合ではなく設計の根幹であり、破ってはならない。

1. **判定は必ずサーバー側**。端末が「異常です」と申告する設計にしない（死んだ端末は送信できない）
2. **ウォッチャーに返すのはステータスと `status_changed_at` のみ**。`last_alive_event_at`・操作時刻・
   行動詳細・閾値・センサーの `last_event_at` を返さない。レスポンスは zod スキーマで固定してあるので、
   勝手に緩めない
3. **位置情報は `sos_incidents` にのみ**。SOS以外で位置を受け取るAPIを作らない。`events.meta` と
   `audit_log.detail` に座標・アプリ名・URL・開閉状態を入れない
4. **操作0のハートビートを生存イベント扱いしない**。「端末が生きている」≠「本人が生きている」
5. **`audit_log` は削除しない**（免責の証跡）。SOSのpurge対象外
6. **時間帯バケットは `src/lib/timezone.ts` の基準TZで統一**。学習側SQLと判定側JSがズレると誤報になる
7. **SOSは自動復帰させない**。手動resolveのみ
8. **低信頼ソース（`confidence < 80`）を生存イベント扱いしない**。`last_alive_event_at` を更新させない。
   ここを緩めると冷蔵庫の稼働が住人の死後も生存を証明し続け、**デッドマンスイッチが永久に発報しない**
9. **クロス判定の ALERT 保留には必ず上限を置く**（`CROSS_CHECK_HOLD_MINUTES`）。
   弱シグナルは本人が倒れていても出続ける。無制限にすると 8 と同じ結末になる
10. **信頼度はサーバーが決める**。リクエスト・Webhook から `confidence` を受け取らない（1と同じ理由）

4・8・9 はいずれも「見守っているつもりで誰も見ていない」状態を防ぐためのもの。
誤報（うるさい）より検知漏れ（気づけない）の方が致命的、という優先順位を崩さないこと。
