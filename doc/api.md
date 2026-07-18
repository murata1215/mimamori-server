# mimamori-server API リファレンス (Phase 1 + Phase 2)

Base URL: `https://mimamori-server.devrelay.io`

認証は JWT（`Authorization: Bearer <token>`）。トークンは2系統あり、**互いのAPIを叩けない**。

| 種別 | 発行 | 対象 |
|---|---|---|
| watcher access | ログイン | ウォッチャーAPI |
| watcher refresh | ログイン | 再発行のみ（APIは叩けない） |
| device | ペアリング | クライアント端末API |

---

## 認証・ペアリング

### `POST /v1/watchers/register-device` 🔓認証不要（IP 10回/時）
匿名端末登録。メール+パスワードなしでウォッチャーアカウントを作成。
同一 `install_id` で再呼び出しすると既存 watcher のトークンを再発行（冪等）。
```json
{ "install_id": "uuid-v4", "display_name": "太郎", "platform": "android" }
→ 201 { "watcher_id": "...", "access_token": "...", "refresh_token": "..." }  // 新規
→ 200 { "watcher_id": "...", "access_token": "...", "refresh_token": "..." }  // 既存
→ 400 invalid_request / 429 rate_limit
```

### `POST /v1/watchers` — ウォッチャー登録（メール+パスワード）
```json
{ "display_name": "けいすけ", "email": "a@example.com", "password": "8文字以上" }
→ 201 { "watcher_id": "...", "access_token": "...", "refresh_token": "..." }
→ 409 email_taken
```

### `POST /v1/watchers/login`
```json
{ "email": "a@example.com", "password": "..." }
→ 200 { "watcher_id": "...", "access_token": "...", "refresh_token": "..." }
→ 401 invalid_credentials
```
ユーザー列挙を防ぐため、未登録メールでも同じ応答時間・同じエラーを返す。

### `POST /v1/watchers/refresh`
```json
{ "refresh_token": "..." } → 200 { "access_token": "...", "refresh_token": "..." }
```

### `GET /v1/watchers/me` 🔒watcher
```json
→ { "id","display_name","email","plan","notify_watch","phone_number","total","billable" }
```

### `PUT /v1/watchers/me/fcm-token` 🔒watcher
```json
{ "fcm_token": "..." } → { "ok": true }
```

### `PUT /v1/watchers/me/settings` 🔒watcher
```json
{ "notify_watch": true, "phone_number": "+8190..." } → { "ok": true }
```

### `PATCH /v1/watchers/me` 🔒watcher — プロフィール更新
```json
{ "display_name": "新しい名前" } → 200 { "ok": true }
→ 400 invalid_request
```

### `POST /v1/watchers/me/email` 🔒watcher — 匿名→メール登録
匿名ウォッチャーにメール+パスワードを追加。機種変更時の復元等に。
```json
{ "email": "a@example.com", "password": "8文字以上" }
→ 200 { "ok": true }
→ 409 email_taken          // メール重複
→ 409 already_registered   // 既にメール登録済み
```

### `POST /v1/pairing-codes` 🔒watcher
6桁コードを発行（TTL 15分・使い捨て）。
```json
→ 201 { "code": "123456", "expires_in_minutes": 15 }
→ 402 payment_required   // 無料枠(2人)超過 → ペイウォールを表示
```

### `POST /v1/clients/pair` 🔓認証不要
コード自体が認証材料。**`consent_version` は必須**（法務要件: 同意なしにクライアントを作らない）。
```json
{
  "code": "123456", "display_name": "母", "consent_version": "v1.0",
  "platform": "android", "app_version": "0.1.0",
  "fcm_token": "...", "usage_frequency": "occasional"  // "frequent"→10h / "occasional"→15h(Android), 24h(iOS)
}
→ 201 { "client_id": "...", "device_id": "...", "device_token": "..." }
→ 400 invalid_code   // 無効・期限切れ・使用済み
```

### `POST /v1/provisions` 🔓認証不要（IP レート制限: 10回/時）
逆方向ペアリング: 高齢者端末が自己登録し QR を表示 → ウォッチャーがスキャン。
**`consent_version` は必須**（法務要件: 本人端末から受け取る）。
clients / devices / watch_links には一切書き込まない（provisions テーブルのみ）。
```json
{ "platform": "android", "consent_version": "v1.0",
  "app_version": "0.1.0", "fcm_token": "..." }
→ 201 {
    "provision_id": "uuid",
    "claim_code": "base64url-32bytes...",     // QR 用の長いランダム文字列
    "fallback_code": "123456",                // 手入力用6桁
    "claim_secret": "base64url-32bytes...",    // ポーリング認証用（claim_code とは別値）
    "expires_in_minutes": 30
  }
→ 400 invalid_request
→ 429 rate_limit
```

### `GET /v1/provisions/me` 🔒claim_secret（`Authorization: Bearer <claim_secret>`）
ポーリング（3〜5秒間隔）。claim されるまで `{ "claimed": false }` を返す。
claim 後は正式な device_token を返す。**JWT ではなく provision 時に受け取った claim_secret を Bearer で送る。**
```json
→ 200 { "claimed": false }
→ 200 { "claimed": true, "device_token": "jwt...", "client_id": "uuid" }
→ 401 unauthorized          // claim_secret がない
→ 404 not_found / expired   // 存在しない or 期限切れ
```

### `POST /v1/clients/claim` 🔒watcher
ウォッチャーが provision を自分の見守り対象として登録。`code` は `claim_code`（QR）と `fallback_code`（6桁）のどちらも受け付ける。
```json
{ "code": "claim_code or fallback_code", "display_name": "おばあちゃん",
  "usage_frequency": "occasional" }
→ 201 { "client_id": "uuid" }
→ 400 invalid_code           // 無効 or 期限切れ
→ 402 payment_required       // 無料枠(2人)超過
→ 409 already_claimed        // 使用済み
```

### `POST /v1/invite-codes` 🔒device（10回/時）
既存クライアントへの追加ウォッチャー招待コード発行。client_id はデバイストークンから取得。
新規 client/device は作らない。TTL 30分。
```json
→ 201 {
    "invite_id": "uuid",
    "invite_code": "base64url-32bytes...",
    "fallback_code": "123456",
    "expires_in_minutes": 30
  }
```

### `GET /v1/invite-codes/:invite_id` 🔒device
招待の join 状態ポーリング。自分の client_id に紐づく invite のみ。
```json
→ 200 { "joined": false }
→ 200 { "joined": true, "watcher_name": "太郎" }
→ 404 not_found
```

### `POST /v1/clients/join` 🔒watcher
ウォッチャーが招待を受けて watch_link のみ作成。`code` は `invite_code`（QR）と `fallback_code`（6桁）の両方。
```json
{ "code": "invite_code or fallback_code", "display_name": "おばあちゃん" }
→ 201 { "client_id": "uuid" }
→ 402 payment_required     // 無料枠超過
→ 404 not_found            // 無効 or 期限切れ
→ 409 already_used         // コード消費済み
→ 409 already_joined       // 同一 watcher が既に紐づき済み
```

### `GET /v1/clients/me/watchers` 🔒device
紐づきウォッチャーの名前一覧（最小開示）。
```json
→ 200 [ { "display_name": "太郎" }, { "display_name": "花子" } ]
```

---

## クライアント端末 🔒device

### `POST /v1/clients/me/email` 🔒device — クライアントのメール登録
機種変更に備え、既存クライアントにメール+パスワードを付与する。
登録後は `/v1/clients/login` で新端末にログインできる。
```json
{ "email": "grandma@example.com", "password": "8文字以上" }
→ 200 { "ok": true }
→ 409 already_registered   // 既にメール登録済み
→ 409 email_taken          // 他クライアントが使用中
```
watchers と clients で同一メールを登録可能（別テーブル・別ロール）。

### `POST /v1/clients/login` 🔓認証不要（IP 10回/時）
メール+パスワードで認証し、同じ client_id に新デバイスを登録する。
**旧デバイスは全て無効化される**（`deactivated_at` 設定 → 旧端末のJWTは即座に401）。
watch_links・スタンプ履歴・ステータス履歴はそのまま継続する。
```json
{ "email": "grandma@example.com", "password": "...",
  "platform": "ios", "app_version": "1.2.0",
  "fcm_token": "...", "consent_version": "v2.0" }
→ 200 { "client_id": "uuid", "device_id": "uuid", "device_token": "jwt..." }
→ 401 invalid_credentials
```
ユーザー列挙を防ぐため、未登録メールでも同じ応答時間・同じエラーを返す。
`consent_version` は必須（新端末での同意記録。`clients.consent_version` / `consent_at` が更新される）。

### `POST /v1/heartbeats`
バッチ受付（キュー再送対応）。レート制限: 15分あたり20回。

```json
{
  "heartbeats": [{
    "occurred_at": "2026-07-16T12:00:00Z",   // 元の発生時刻を保持（再送時も）
    "battery_level": 80,
    "screen_on_count": 3,        // 回数のみ。時刻詳細は送らない
    "had_app_usage": true,       // boolean のみ。何のアプリかは送らない
    "had_movement": true,        // 移動有無。boolean のみ。座標・距離・軌跡は送らない
    "app_version": "0.1.0"
  }],
  "delivery_stats": { "sent": 10, "failed": 0, "queued": 0 }   // KPI計測用
}
→ { "accepted": 1, "duplicates": 0, "revived": true }
```

**生存イベント扱いになる条件**: `screen_on_count > 0` または `had_app_usage = true` または `had_movement = true`。
いずれも0/false/省略のハートビートは「端末は生きているが操作なし」として経過時間のカウントを継続する。

未来時刻の `occurred_at` は受信時刻に丸める（端末の時計ズレ対策）。
同一 `occurred_at` の再送は重複として無視（冪等）。

### `POST /v1/sos`
**位置情報を受け取る唯一のエンドポイント。** 判定ジョブを介さず即時にウォッチャーへ通知。
```json
{ "lat": 35.6812, "lng": 139.7671, "battery_level": 15,
  "location_captured_at": "2026-07-18T00:30:00Z" }
// lat/lng は省略可（位置不明でも送信優先）
// location_captured_at: キャッシュ位置の測位時刻。省略時はSOS発動時刻扱い
→ 201 { "incident_id": "..." }
```

### `POST /v1/confirm-alive`
本人確認への応答。即 ALIVE へ復帰。
```json
→ { "ok": true, "status": "ALIVE" }
```

### `POST /v1/permission-health`
```json
{ "issues": ["usage_stats", "battery_optimization"] }  → { "ok": true }
```
空配列なら通知しない（問題解消の申告）。

### `PUT /v1/devices/me/fcm-token`
```json
{ "fcm_token": "..." } → { "ok": true }
```

---

## スタンプ（双方向コミュニケーション）

テキストメッセージなし。スタンプ（文字列コード）のみ。初期セット: `fine` / `not_well` / `bad`（種類追加時にスキーマ変更不要）。

### `POST /v1/stamps` 🔒device
クライアント→全ウォッチャー宛。レート制限: 30回/時。
```json
{ "stamp": "fine" }
→ 201 { "stamp_id": "123" }
```

### `GET /v1/stamps/me` 🔒device
クライアントの送受信履歴（新しい順）。cursor ページネーション。
```json
→ 200 [
    { "id": "124", "stamp": "fine", "direction": "from_watcher",
      "sender_name": "太郎", "created_at": "2026-07-17T10:00:00.000Z" },
    { "id": "120", "stamp": "fine", "direction": "from_client",
      "sender_name": "おばあちゃん", "created_at": "2026-07-17T09:00:00.000Z" }
  ]
// ?limit=50&before_id=124 で2ページ目
```

### `POST /v1/clients/:client_id/stamps` 🔒watcher
ウォッチャー→クライアント宛。watch_link なし→404。
```json
{ "stamp": "fine" }
→ 201 { "stamp_id": "123" }
```

### `GET /v1/clients/:client_id/stamps` 🔒watcher
ウォッチャーから見た双方向履歴。watch_link なし→404。形式は `GET /v1/stamps/me` と同じ。
```
?limit=50&before_id=124
```

---

## ウォッチャー 🔒watcher

### `GET /v1/clients`
**返すのはステータスのみ。イベントデータは絶対に返さない**（原則1）。
緊急度順（SOS→ALERT→CONFIRMING→WATCH→ALIVE）にソート済み。

```json
[{
  "id": "...", "display_name": "母",
  "status": "ALIVE",                      // ALIVE|WATCH|CONFIRMING|ALERT|SOS
  "status_changed_at": "2026-07-16T...",
  "has_issue": false,                     // 端末沈黙（45分以上HBなし）= 灰色バッジ
  "property_tag": null
}]
```

`last_alive_event_at` / `battery_level` / `threshold` 等は**構造的に返らない**
（zodのレスポンススキーマで固定。スキーマを通らない値は500になり漏れない）。

### `GET /v1/clients/:id/status-history`
遷移のみの粒度。判定内部情報（閾値等）は含まない。
```json
[{ "from": "WATCH", "to": "ALIVE", "changed_at": "2026-07-16T..." }]
```

### `GET /v1/clients/:client_id/sos/active`
クライアントのアクティブ（未解決）SOS を取得。複数あれば最新1件。
FCM 通知を受け取れなかった場合のフォールバック。`status === 'SOS'` のクライアントに対して呼ぶ。
```json
→ 200 {
    "id": "uuid", "client_id": "uuid", "client_name": "母",
    "latitude": 35.68, "longitude": 139.77, "battery_level": 42,
    "fired_at": "2026-07-18T...", "resolved_at": null,
    "location_captured_at": "2026-07-18T01:00:00.000Z"
  }
→ 404 not_found   // アクティブ SOS なし or 権限なし
```

### `GET /v1/sos/:id`
位置を含む唯一のレスポンス。**resolve後・purge後(30日)は404**。
```json
{ "id","client_id","client_name","latitude","longitude","battery_level","fired_at","resolved_at","location_captured_at" }
```

### `POST /v1/sos/:id/resolve`
```json
{ "outcome": "was_safe" }   // was_safe | was_real（誤報率KPIの集計に使う）。省略可
→ { "ok": true }
```
`outcome` は optional。**ボディ省略・`{}` でも 400 にならず 200 を返す**（`req.body ?? {}` で受ける）。
解決すると位置へのアクセスが即座に不可になり、状態が ALIVE へ戻る。

### `POST /v1/clients/:id/resolve-alert`
```json
{ "outcome": "was_safe" }   // 必須
→ { "ok": true }
→ 409 not_in_alert
```
`was_safe` のみ ALIVE へ戻す。`was_real` は状態を維持（対応中）。**誤報率KPIの計測に必須**。

---

## センサー（Phase 2）🔒watcher

対応ソースと信頼度（**信頼度はサーバーが決める。リクエストからは指定できない**）:

| source_type | confidence | 生存判定への効き方 |
|---|---|---|
| `switchbot_contact` | 100 | 生存イベント。**即 ALIVE 復帰** |
| `switchbot_plug` | 100 | 生存イベント。即 ALIVE 復帰 |
| `power_meter` | 70 | **弱シグナル。ALIVE 復帰しない**（クロス判定にのみ使う） |

### `POST /v1/clients/sensor-only`
スマホを持たない人／センサーのみ物件のクライアントを作る（`has_app=false`）。
判定は CONFIRMING をスキップし、WATCH → 猶予 → ALERT になる。
```json
{ "display_name": "空き家A", "consent_version": "v1.0", "property_tag": "物件A" }
→ 201 { "client_id": "...", "has_app": false, "message": "センサーを登録するまで見守りは開始されません" }
→ 402 payment_required   // 無料枠(2人)超過。ペアリング経路と同じ枠を消費する
```
同意は**ウォッチャーによる代理申告**として記録される（本人が操作する画面が無いため）。
監査ログに `consent_by: "watcher_declaration"` が残る。同意取得の実体はサービス外で担保すること。

### `POST /v1/clients/:id/sensors`
```json
{ "source_type": "switchbot_contact", "source_id": "AA:BB:CC:DD:EE:01", "display_name": "玄関" }
→ 201 { "id": "...", "source_type": "...", "is_primary_signal": true }
→ 409 sensor_already_registered   // 1デバイス = 1クライアント。登録先は漏らさない
→ 404                              // 権限なし
```

### `GET /v1/clients/:id/sensors`
**返すのは設定情報のみ。観測結果は返さない**（原則1）。
```json
[{ "id","source_type","source_label","display_name","enabled","is_primary_signal","created_at" }]
```
`last_event_at`（＝玄関が最後に開いた時刻）は**構造的に返らない**。SQLで取得すらしていない。

### `PUT /v1/clients/:id/sensors/:sensorId`
```json
{ "display_name": "勝手口", "enabled": false } → { "ok": true }
```
`enabled=false` のセンサーからのWebhookは404になり、イベントは取り込まれない。

### `DELETE /v1/clients/:id/sensors/:sensorId`
```json
→ { "ok": true }
→ { "ok": true, "warning": "有効なセンサーが無くなりました。このクライアントは見守れません" }
```
警告は `has_app=false` のクライアントから最後の有効センサーを外した場合のみ。

---

## オーナープラン 🔒watcher + plan=owner

無料プランは全て **402 payment_required**。

- `GET /v1/owner/dashboard` — 物件別サマリ `{ properties: [{ property_tag, total, alive, watch, confirming, alert, sos }] }`
- `GET /v1/owner/alerts.csv` — アラート履歴CSV（BOM付き・CSVインジェクション対策済み）
- `GET /v1/owner/report` — 月次稼働レポート `{ uptime_percent, outage_minutes, clients_count, alerts_count }`
- `PUT /v1/clients/:id/property-tag` — 物件タグ設定

---

## Webhook / 監視

- `POST /v1/webhooks/revenuecat` — `Authorization` ヘッダ照合（定数時間比較）。未設定時は503
- `GET /healthz` — 外形監視用（DB＋判定ジョブ。10分停止で503）
- `GET /livez` — プロセス生存のみ。**外形監視には使わない**
- `GET /` — 公開ステータスページ（HTML）。`/statusz` を fetch して表示。バックエンド停止時は Caddy が同HTMLをフォールバック表示
- `GET /statusz` 🔓認証不要 — 公開ステータス（集計のみ）。常に200。**外形監視には使わない（表示用）**

### `GET /statusz` 🔓認証不要
ログイン不要で稼働状態と利用者数の**集計値のみ**を返す。60秒キャッシュ。
```json
{ "service": "mimamori-server",
  "status": "ok",            // 'ok' | 'starting' | 'unhealthy'（healthz と同じ判定）
  "watchers": 3,             // みまもりユーザー数
  "clients": 2,              // みまもられるユーザー数
  "unique_users": 5,         // watchers + clients
  "watch_links": 4,          // 見守り接続（ペア）数
  "devices": 2,              // 登録端末数
  "generated_at": "2026-07-17T08:00:00.000Z" }
```
**個人名・ID・個別ステータス・ステータス別内訳（ALERT/SOS件数）・時刻情報は絶対に返さない**
（絶対ルール2/3。集計以外を公開すると特定物件の異常を部外者に推測される）。

### `POST /v1/webhooks/switchbot` 🔓署名認証
HMAC-SHA256（`sign` / `t` / `nonce` ヘッダ）＋5分のリプレイ窓。未設定時は503。
```json
{ "eventType": "changeReport",
  "context": { "deviceMac": "AA:BB:CC:DD:EE:01", "openState": "open", "timeOfSample": 1784238000000 } }
→ 200 { "ok": true }
→ 200 { "ok": true, "ignored": true }   // 人の行動を示さない状態変化
→ 401 invalid_signature / stale_signature
→ 404 unknown_device                     // 未登録 or 無効化済み
```
行動とみなす条件: `openState` が `open`/`close`、`detectionState` が `DETECTED`、`powerState` が `ON`/`OFF`。
`timeOfSample` は未来・7日超過去なら受信時刻へ丸める（時計ズレでデッドマンスイッチが止まるのを防ぐ）。
**`meta` には行動詳細を残さない**（`openState` すら保存しない。判定に要るのは「動きがあった」事実のみ）。

### `POST /v1/webhooks/power-meter` 🔓`Authorization` 照合
電力Bルート/電力会社APIの30分値。未設定時は503。
```json
{ "meter_id": "METER-0001", "watt_hours": 800, "measured_at": "2026-07-17T06:00:00Z" }
→ 200 { "ok": true }
→ 200 { "ok": true, "ignored": true }   // 300Wh 未満（待機電力レベル）
```
**このソースは ALIVE 復帰を起こさない。** confidence 70 の弱シグナルとして
`clients.last_weak_signal_at` に入り、クロス判定にのみ使われる。理由は下記。

---

## FCM プッシュ通知の data payload

サーバーから送るプッシュの `data` は全て**文字列値**（FCMの制約）。`kind` で種別を判別する。
`client_id` は全 push に付与される。ウォッチャー宛の kind には `client_name`
（クライアントの `display_name`）も載る — 端末がオフライン・起動直後でも API 照会なしに
「誰の」通知かを表示できるようにするため（flutter連携 2026-07-17）。

| kind | 送信先 | data の追加キー |
|---|---|---|
| `confirming` | クライアント端末 | （`client_id` のみ） |
| `silent` | クライアント端末 | `action`（`heartbeat_now`） |
| `watch` | ウォッチャー | `status`, `client_name` |
| `alert` | ウォッチャー | `status`, `client_name`, `device_silent` |
| `sos` | ウォッチャー | `status`, `client_name`, `incident_id`, `location_captured_at`（キャッシュ位置時のみ） |
| `permission` | ウォッチャー | `status`, `client_name`, `reason` |
| `outage` | 全ウォッチャー | `gap_minutes`（※特定クライアントに紐づかないため `client_id` / `client_name` は無い） |
| `stamp` | ウォッチャー（from_client 時） | `stamp`, `client_name`, `direction`（`from_client`） |
| `stamp` | クライアント端末（from_watcher 時） | `stamp`, `sender_name`, `direction`（`from_watcher`） |

```json
// alert の例
{ "kind": "alert", "client_id": "uuid", "client_name": "母", "status": "ALERT", "device_silent": "true" }
```

`confirming` / `silent` はクライアント端末宛のため `client_name` を持たない。
`outage` はサービス停止の一斉通知で、特定クライアント文脈が存在しないため
`client_id` / `client_name` を持たない。

---

## エラー形式

```json
{ "error": "invalid_request", "issues": [...] }   // 400（zod詳細）
{ "error": "unauthorized" }        // 401 認証なし・無効トークン
{ "error": "device_deactivated" }  // 401 機種変更で無効化されたデバイス
{ "error": "forbidden" }           // 403 ロール違い（device↔watcher）
{ "error": "not_found" }           // 404（権限なしも404。存在有無を漏らさない）
{ "error": "payment_required" }    // 402 課金が必要
{ "error": "internal_error" }      // 500（詳細は返さない）
```
