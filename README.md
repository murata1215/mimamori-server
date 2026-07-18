# mimamori-server

生存シグナル統合判定エンジン。独居者の異常を早期に検知し、発見の遅れを防ぐ。

複数のセンサー（端末操作・SwitchBot・電力メーター等）から「本人が生きている」というシグナルを集約し、
一定時間途絶えたことをサーバー側で判定して、あらかじめ登録されたウォッチャーへ通知する。
いわゆるデッドマンスイッチ。

## 設計の根幹

このサービスは命に関わる。以下は仕様の都合ではなく設計の前提であり、変更してはならない。

1. **判定は必ずサーバー側で行う。** 端末が「異常です」と申告する設計にしない。死んだ端末は何も送信できないため、
   端末の沈黙そのものを異常とみなす必要がある
2. **ウォッチャーに返すのはステータスと `status_changed_at` のみ。** 最終生存時刻・操作時刻・行動詳細・
   閾値を返さない。見守りは監視ではない
3. **位置情報は SOS 発報時のみ受け取り、`sos_incidents` にのみ保存する。** 30日で物理削除する
4. **操作0のハートビートを生存イベントとして扱わない。** 「端末が生きている」と「本人が生きている」は別
5. **低信頼ソース（`confidence < 80`）で最終生存時刻を更新しない。** ここを緩めると冷蔵庫の稼働が
   住人の死後も生存を証明し続け、デッドマンスイッチが永久に発報しなくなる

**誤報（うるさい）より検知漏れ（気づけない）の方が致命的**、という優先順位を崩さないこと。
「見守っているつもりで、実は誰も見ていない」状態を作らないことが、この設計全体の目的にあたる。

## 動作環境

Node.js 20 以上、PostgreSQL。

## セットアップ

```bash
npm install
cp .env.example .env   # DATABASE_URL / PORT / JWT_SECRET を設定
npm run migrate        # マイグレーション（冪等）
npm run dev            # 開発サーバー
```

## 開発

```bash
npm run typecheck   # 型チェック（本体 + tests。tests は別 tsconfig なので忘れずに）
npm test            # テスト（実DBを使う統合テストを含む）
npm run build       # ビルド
```

## 主なエンドポイント

API の全量は `doc/api.md` を参照。代表的なものは以下。

| 区分 | エンドポイント | 概要 |
|------|----------------|------|
| 公開 | `GET /statusz` | ログイン不要の稼働状況・利用者数（集計値のみ） |
| 監視 | `GET /healthz` / `GET /livez` | 見守りが機能しているか / プロセス生存のみ |
| 見守られ側 | `POST /v1/clients/pair` / `POST /v1/clients/claim` | ペアリング（順・逆方向） |
| 見守られ側 | `POST /v1/clients/me/email` / `POST /v1/clients/login` | メール認証・機種変更 |
| 見守られ側 | `POST /v1/heartbeat` / `POST /v1/sos` | 生存シグナル / SOS 発報 |
| ウォッチャー | `GET /v1/clients` / `GET /v1/clients/:id/activity` | 一覧 / 日次活動サマリ |
| ウォッチャー | `GET /v1/clients/:id/sos/active` | アクティブ SOS 取得（FCM 未達フォールバック） |
| ウォッチャー | `DELETE /v1/clients/:id` | 見守り紐づけの解除（自分の watch_link のみ） |
| 多対多 | `POST /v1/invite-codes` / `POST /v1/clients/join` | 追加ウォッチャーの招待・参加 |

ウォッチャーに返すのはステータスと遷移時刻のみ。集計 API も含め、操作時刻・行動詳細・位置は返さない
（詳細は `rules/project.md`）。

## プッシュ通知（FCM / APNs）

通知は FCM で配信する。`.env` の `FIREBASE_CREDENTIALS_PATH` が未設定だと no-op ドライバに
なり通知が一切飛ばないため、本番では必須（認証情報は `credentials/` に置き git 管理外）。
iOS では silent（background）push を届けるために `apns` フィールドを付与している
（`kind:'silent'` は `content-available:1` + `apns-priority:5`）。ペイロード仕様は
`buildFcmMessage`（`src/notify/fcm.ts`）に集約。iOS 配信には Firebase コンソールへの
APNs 認証キー (.p8) 登録が別途必要。

## 新しいセンサーを追加するとき

`src/engine/sources.ts` に定義を足し、Webhook アダプタを書くだけでよい。
**判定エンジン・状態遷移・学習・通知を改修してはならない。** 改修が必要になった時点で、
アダプタの設計を間違えている。

## ドキュメント

| 文書 | 内容 |
|------|------|
| `doc/api.md` | API リファレンス |
| `doc/operations.md` | 運用・監視・トラブルシューティング |
| `doc/issues.md` | 課題管理 |
| `doc/changelog.md` | 変更履歴と設計判断の根拠 |

## 運用上の必須要件

`/healthz` を **1分間隔で外形監視すること。** このエンドポイントは「サーバーが応答するか」ではなく
「見守りが機能しているか」を返す（DB接続不可や判定ジョブの停止で503）。

`/livez` はプロセスの生存のみを返すため、**外形監視に使ってはならない**。判定ジョブが死んでいても200を返す。

このサービスは自分自身の沈黙を許されない。詳細は `doc/operations.md` を参照。
