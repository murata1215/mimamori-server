# プロジェクト固有ルール

`CLAUDE.md` の「実装上の絶対ルール」を前提とする。ここには、実装を重ねる中で確定した
設計判断のうち、次に触る人が同じ罠を踏まないためのものを残す。

## API レスポンス・プライバシー

- **ウォッチャーに返す時刻はステータス遷移時刻のみ。** `last_alive_event_at`・操作時刻・
  センサーの `last_event_at`・閾値は zod スキーマで固定して返さないこと（絶対ルール2）。
  日次活動サマリ（`GET /v1/clients/:id/activity`）も**集計値のみ**で、操作時刻・アプリ名・
  位置を返さない。
- **公開エンドポイント（`GET /statusz`）は集計値のみ。** 個人名・ID・ステータス別内訳
  （ALERT/SOS 件数）・時刻を露出しないこと。テストで露出しないことを固定してある。
- **位置情報は SOS のときだけ。** `POST /v1/sos` の `location_captured_at` は「いつ取得した位置か」
  の時刻のみで、座標は `sos_incidents` にしか入れない。heartbeat の `had_movement` は
  boolean のみで、座標・距離・軌跡は受け取らない（絶対ルール3）。

## 生存判定

- **`had_movement` は `screen_on_count > 0` と同格の生存シグナル。** `isAliveEvent()` は
  `screen_on_count > 0 || had_app_usage === true || had_movement === true`。
  `had_movement: false` は生存イベントではない（省略と同義）。
- **初期しきい値は `getInitialThreshold(platform, usageFrequency)`（`src/lib/plan.ts`）に集約。**
  frequent 申告 → 600分、iOS → 1440分（バックグラウンド実行が OS 任せで間隔が長い）、
  それ以外 → 900分。**機種変更ログイン（`clients/login`）では既存 threshold を上書きしない**
  （学習済み値を保護）。

## 認証・端末ライフサイクル

- **クライアント（見守られ側）はメール認証で機種変更に対応する。** `clients/login` は
  旧デバイスを全て `deactivated_at = now()` で無効化してから新デバイスを INSERT する。
  `requireDevice` は `devices.deactivated_at IS NULL` を毎リクエスト検証し、無効端末は 401
  `device_deactivated` を返す。
- **watcher と client は同一メールを別人格として登録できる**（UNIQUE 制約はテーブル別）。

## 見守り関係の管理

- **`DELETE /v1/clients/:client_id` は自分の watch_link のみ削除する。** client レコード・
  他ウォッチャーの watch_link・billable フラグには触れない。最後のウォッチャーが解除しても
  client は残る（通知先ゼロになるだけ）。冪等ではなく、解除済みなら 404。
- **権限のないクライアント操作は一律 404**（存在を秘匿。403 と区別しない）。
- watch_link の増減は `audit_log`（`watch_link_removed` など）に必ず残す（免責の証跡・絶対ルール5）。

## プッシュ通知（FCM / APNs）

- **メッセージ組み立ては純粋関数 `buildFcmMessage(req)`（`src/notify/fcm.ts`）に集約。**
  `FirebaseFcmDriver.send()` はこれを呼ぶだけ。優先度・ペイロード仕様を変える時はここを直し、
  `tests/fcm-message.test.ts` で固定する。
- **iOS には `apns` フィールドが必須。** サーバーはトークン宛に送るだけで OS を区別しないが、
  silent（`kind:'silent'`）push は `apns.payload.aps['content-available']:1` ＋
  `apns-priority:5` が無いと iOS で配信されずアプリが起きない。silent の aps には
  alert / sound / badge を混ぜない（純粋な background push にする）。
- **優先度対応**: `silent`=Android high / apns 5、`confirming`/`alert`/`sos`=high / apns 10 + sound、
  `watch`/`permission`/`outage`/`stamp`=normal / apns 5。Android 挙動（priority・ttl）は変えない。
- **iOS 配信は Firebase コンソールの APNs 認証キー (.p8) 登録が前提**（サーバー外）。
  silent push は OS に間引かれ得るため、iOS の生存判定はこれに依存させない（初期閾値 24h）。

## Flutter クライアント互換

- **DELETE / POST の空ボディ + `Content-Type: application/json` を受理する。** dio がこの形で
  送るため、`src/app.ts` の `addContentTypeParser` で空ボディを `undefined` として通す。
  ハンドラ側の `?? {}` では手遅れ（パーサーが先に 400 にする）。
- **招待コードの投入先を混同しない。** provision（逆方向ペアリング）は `POST /v1/clients/claim`、
  invite-code（追加ウォッチャー）は `POST /v1/clients/join`。前者は新規 client を作り、
  後者は watch_link のみ作る。別テーブルを引くので取り違えると 400/404 になる。
