# Changelog

## 2026-07-18 — 日次活動サマリ API

ウォッチャー詳細画面に「過去N日間の活動量」を表示するための集計API。

- `GET /v1/clients/:client_id/activity?days=3` 🔒watcher: 日別の活動量を集計して返す。
  days は 1-7（デフォルト3）。古い日→新しい日の順。データ無し日は 0 埋め。
- 集計項目: screen_on_count / app_usage_slots / movement_slots / heartbeat_count /
  active_buckets (4h時間帯バケット数, 0-6) / battery_min / battery_max。
- `events.meta` (jsonb) を Asia/Tokyo の日付境界で GROUP BY。
- zod スキーマで固定。操作時刻・アプリ名・位置は一切返さない（原則1）。
- 判定エンジン・状態遷移・通知は無改修。

## 2026-07-18 — アクティブ SOS 取得 API

ウォッチャーが FCM 通知を受け取れなかった場合でも、クライアント一覧で `status='SOS'` を
検出した Flutter が `incident_id` を取得して SOS 画面に遷移できるようにする。

- `GET /v1/clients/:client_id/sos/active` 🔒watcher: アクティブ（未解決）SOS の最新1件を返す。
  既存の `sosDetailSchema` を流用。watch_links 権限チェック。アクティブなし / 権限なし → 404。
- 判定エンジン・状態遷移・通知は無改修。

## 2026-07-18 — iOS 端末向け初期しきい値

iOS はバックグラウンド実行が OS 任せで 15分周期ハートビートが保証されず、
screen_on_count / had_app_usage 相当の API もないため、生存シグナル間隔が Android より長い。
初期しきい値を長めに設定して誤報を防ぐ。学習エンジンが実シグナル間隔 p99 を学習すれば自然収束する。

- `config.DEFAULT_THRESHOLD_MINUTES_IOS = 1440`（24時間）を追加。既存 Android 用（900分/15時間）は不変。
- 初期閾値決定を `getInitialThreshold(platform, usageFrequency)` ヘルパーに集約（`src/lib/plan.ts`）。
  `frequent` 申告 → 600分（platform 不問）、iOS → 1440分、それ以外 → 900分。
- `clients/pair` と `clients/claim` の2箇所で共通ヘルパーを使用。
- `clients/login`（機種変更）は既存 threshold を上書きしない（学習済み値を保護）。
- 判定エンジン・状態遷移・通知・学習エンジンは無改修。

## 2026-07-18 — 移動有無シグナル + SOS キャッシュ位置フォールバック

### had_movement（移動有無）
- heartbeat ペイロードに optional `had_movement` (boolean) を追加。
- `isAliveEvent()` の判定条件に `had_movement === true` を追加。
  `screen_on_count > 0 || had_app_usage === true || had_movement === true` で生存イベント。
- **座標・距離・軌跡は受け取らない**（プライバシー原則不変。events.meta に boolean のみ格納）。
- 省略時は従来どおり（既存ペイロード互換。判定に影響なし）。
- `had_movement: false` は生存イベントではない（`screen_on_count: 0` と同じ扱い）。

### location_captured_at（SOS キャッシュ位置）
- `POST /v1/sos` に optional `location_captured_at` (ISO8601) を追加。
- マイグレーション（009）: `sos_incidents.location_captured_at timestamptz` を追加。
- 省略時は null（= fired_at と同義。新規測位成功時）。
- `GET /v1/sos/:id` のレスポンスに `location_captured_at` を追加（null 許容）。
- SOS FCM 通知の data に `location_captured_at` を含める（キャッシュ位置時のみ）。
- 判定エンジン・状態遷移の基本フローは無改修。

## 2026-07-18 — クライアント機種変更対応

クライアント（見守られ側）にもメール認証を追加し、機種変更時に再ペアリング不要にした。

- マイグレーション（008_client_auth.sql）: `clients.email text UNIQUE` / `clients.password_hash text` を追加（NULL可）。
  `devices.deactivated_at timestamptz` を追加し `idx_devices_active` 部分インデックスを作成。
- `POST /v1/clients/me/email` 🔒device: デバイストークン認証でメール+パスワード付与。
  409 `already_registered` / 409 `email_taken`。watchers と clients で同一メール登録可能。
- `POST /v1/clients/login` 🔓認証不要（IP 10回/時）: メール+パスワードで認証 → 旧デバイス全無効化
  （`deactivated_at = now()`）→ 新デバイス INSERT → `consent_version` / `consent_at` 更新 →
  device JWT 発行 → `audit_log` に `client_device_login` 記録。
- `requireDevice` にデバイス有効性チェックを追加: `SELECT 1 FROM devices WHERE id = $1 AND deactivated_at IS NULL`。
  0行なら 401 `device_deactivated`。旧端末のJWTは即座に無効化され、confirm_alive 誤復帰・
  screen_on_count による生存イベント汚染を防ぐ。
- 判定エンジン・状態遷移・通知は無改修。watch_links は client_id 紐づけなので自動継続。

### 旧端末無効化の設計根拠
旧端末を無効化しないと:
- confirm_alive が旧端末から応答され ALIVE に誤復帰する（絶対ルール1「判定はサーバー側」違反）
- 旧端末を他人が操作すると screen_on_count>0 が生存イベント扱いされ、本人の死亡を見逃す
- last_heartbeat_at が更新され続け、端末沈黙検出が機能しない

物理削除ではなく論理削除（deactivated_at）にしたのは、audit_log との突き合わせで
「いつ・どのデバイスが有効だったか」を追跡するため。

## 2026-07-17 — 匿名ウォッチャー登録（ログイン不要化）

ウォッチャーの登録障壁を下げるため、メール+パスワードなしでの端末登録を可能にした。

- マイグレーション（007_anonymous_watchers.sql）: `watchers.email` と `password_hash` を NULL 可に変更、
  `install_id text UNIQUE` を追加。PostgreSQL の UNIQUE は NULL 同士で衝突しないため既存の email UNIQUE 制約は維持。
- `POST /v1/watchers/register-device` 🔓認証不要（IP 10回/時）: `install_id` + `display_name` + `platform` で
  匿名ウォッチャーを作成。同一 `install_id` で再呼び出しすると既存 watcher のトークンを再発行（新規 201 / 既存 200）。
  `email` / `password_hash` は NULL のまま。
- `POST /v1/watchers/me/email` 🔒watcher: 匿名アカウントにメール+パスワードを付与（機種変更時の復元等）。
  既にメール登録済みなら 409 `already_registered`、メール重複なら 409 `email_taken`。
- `PATCH /v1/watchers/me` 🔒watcher: `display_name` の変更用。既存の `PUT /v1/watchers/me/settings` とは分離。
- 既存のメール登録（`POST /v1/watchers`）・ログイン・リフレッシュは無変更。
  `password_hash` が NULL の watcher にログインすると `verifyPassword` がダミーハッシュにフォールバックして自然に失敗。
- `GET /v1/watchers/me` が `email: null` を返せるようになった（Flutter で「メール未登録」判定用）。
- `checkClientQuota` / `issueWatcherTokens` / `requireWatcher` / RevenueCat webhook への影響なし。

## 2026-07-17 — 追加ウォッチャー招待（多対多ペアリング）

既存クライアントに2人目・3人目のウォッチャーを紐づけるフローを追加。
新規 client/device は作らず watch_link のみ作成する。

- `invite_codes` テーブル（006_invite_codes.sql）: provision とは分離。
  `invite_code`（QR用long random）+ `fallback_code`（6桁手入力）。TTL 30分。
- `POST /v1/invite-codes` 🔒device: 招待コード発行（10回/時レート制限）
- `GET /v1/invite-codes/:invite_id` 🔒device: join 状態ポーリング（`{joined, watcher_name?}`）
- `POST /v1/clients/join` 🔒watcher: watch_link のみ作成。無料枠チェック適用。
  既に紐づき済みなら 409 `already_joined`、コード消費済みなら 409 `already_used`
- `GET /v1/clients/me/watchers` 🔒device: 紐づきウォッチャーの名前一覧（`display_name` のみ。最小開示）
- 毎時クリーンアップ（provision と同タイミング）
- 判定エンジン・通知配信は既に多対多対応済み（`getWatchersFor` で全 watcher に配信）のため無改修

## 2026-07-17 — スタンプ機能（双方向の軽量コミュニケーション）

クライアント（見守られる側）とウォッチャー（見守る側）でスタンプを双方向にやり取りする機能。
テキストメッセージなし、スタンプのみ。初期セットは `fine` / `not_well` / `bad` の3種。
`stamp` カラムは text（enum にしない）のため、種類追加にスキーマ変更不要。

- `stamps` テーブル（005_stamps.sql）: `direction`（`from_client` / `from_watcher`）で方向を識別。
  `sender_name` は送信時点の display_name をスナップショット保存（名前変更後も正確）。
- `POST /v1/stamps` 🔒device: クライアント→全ウォッチャー宛送信（30回/時レート制限）
- `POST /v1/clients/:client_id/stamps` 🔒watcher: ウォッチャー→クライアント宛送信
- `GET /v1/stamps/me` 🔒device: クライアントの送受信履歴（cursor ページネーション `before_id`）
- `GET /v1/clients/:client_id/stamps` 🔒watcher: ウォッチャー閲覧（watch_link なし→404）
- FCM `kind: 'stamp'`: ウォッチャー宛は `stamp` + `client_name` + `direction`、
  クライアント宛は `stamp` + `sender_name` + `direction` を data に載せる
- 90日経過分は日次クリーンアップ（scheduler で深夜4:30）で物理削除
- 既読管理はサーバー側では行わない（Flutter 側で `last_seen_at` をローカル管理）
- 判定エンジン・状態遷移・既存通知は一切無改修

## 2026-07-17 — 逆方向ペアリング（provision → poll → claim）

見守られる側は高齢者。操作を極限まで減らすため、ペアリングの方向を逆転した。

- 旧フロー: ウォッチャーがコード発行 → 高齢者端末でコード入力 + 名前入力（操作が多い）
- **新フロー**: 高齢者はアプリ起動 + 同意タップ → 端末が自動で QR 表示 → ウォッチャーが
  スキャンして名前入力（高齢者の操作は「同意ボタンを押す」のみ）

### 新規エンドポイント

- `POST /v1/provisions` 🔓認証不要（IP 10回/時のレート制限）
  端末の自己登録。`consent_version`（法務要件: 本人端末から受け取る）と `platform` が必須。
  `claim_code`（QR用長random）+ `fallback_code`（手入力用6桁）+ `claim_secret`（ポーリング認証用、
  claim_code とは別値）を返す。TTL 30分。**clients / devices / watch_links には一切書き込まない**
  （provisions テーブルのみ。claim されなければ期限切れで消える）。
- `GET /v1/provisions/me` 🔒claim_secret（`Authorization: Bearer <claim_secret>`）
  端末が3〜5秒間隔でポーリング。claim 前は `{claimed:false}`、claim 後は正式な `device_token`
  と `client_id` を返す。JWT ではなく平文シークレットを Bearer で送る。
- `POST /v1/clients/claim` 🔒watcher
  ウォッチャーが provision を自分の見守り対象として登録。`code` は `claim_code` と `fallback_code`
  のどちらも受け付ける。client + device + watch_link を1トランザクションで作成。
  監査ログに consent_version を記録（法務証跡）。

### 実装の詳細

- `provisions` テーブル（004_provisions.sql）: claim前は clients/devices に触れない設計。
  claim されなかった provision は毎時のクリーンアップジョブ（scheduler）で物理削除。
- 既存のデバイストークン構造（`DeviceTokenPayload{role:'device', sub:client_id, device_id}`）は
  **変更なし**。provision 時にはデバイストークンを発行せず、claim 完了後にポーリング経由で渡す。
- 旧フロー（`pairing-codes` / `clients/pair`）はそのまま共存。後方互換を維持。
- 判定エンジン・状態遷移・通知は無改修。

## 2026-07-17 — 公開ステータスページ（`GET /` / `GET /statusz`）

ルートURLを、ログイン不要で稼働状況と利用者数がわかる公開ステータスページにした。
先の「案内ページを返す」変更（下記）は本番の pm2（dist 実行）へ未反映のままだったため、
本デプロイで `GET /` の 404 解消とステータスページ化を同時に行う。

- `GET /statusz` 🔓認証不要 — 稼働状態と集計値のみを返す JSON。60秒インメモリキャッシュ
  （誰でも叩けるため DB を保護）。COUNT は 1 クエリにまとめる。常に 200（表示用。
  外形監視は従来どおり `/healthz`）。
  - 返す値: `status`（ok/starting/unhealthy、healthz と同判定）/ `watchers` / `clients` /
    `unique_users`（両者の合算）/ `watch_links` / `devices` / `generated_at`。
- `GET /` — 静的 HTML（`placeholder/index.html`）。ページ内 JS が `/statusz` を fetch して
  数値を埋める。バックエンド停止時は Caddy が同 HTML をフォールバック表示し、fetch 失敗を
  検知して「停止中」表示に切り替わる（1ファイルで稼働時・停止時の両方に対応）。
- **公開するのは集計数のみ**。個人名・ID・個別ステータス・**ステータス別内訳（ALERT/SOS 件数）**・
  時刻情報は出さない（絶対ルール2/3。集計以外を公開すると特定物件の異常を部外者に推測される）。
  テストで個人情報キーが露出しないことを固定した（`tests/api-contract.integration.test.ts`）。
- ヘルス判定ロジックを `evaluateHealth()` に切り出し `/healthz` と `/statusz` で共有。
  API のルート・エラー形式・not-found ハンドラ・判定エンジンは一切変更なし。

## 2026-07-17 — ルートURLで案内ページを返すよう変更

本番起動後、ブラウザで https://mimamori-server.devrelay.io/ を開くと
`{"error":"not_found"}` が表示される（`GET /` ルートが無いため not-found ハンドラが応答）。
API としては正常だが「壊れている」と誤解されるため、案内ページを返すようにした。

- `GET /` — `placeholder/index.html` を `text/html` で返す（`src/routes/health.ts`）。
  起動時に一度だけ読み込み、ファイルが無ければインライン HTML にフォールバック。
  静的配信プラグインは導入しない（1ページのみのため過剰）。
- `GET /favicon.ico` — 204 を返す（ブラウザアクセス時の 404 ログノイズ防止）。
- `placeholder/index.html` の文言を「Under Construction」から
  「見守りサービス API サーバーです」に更新。このファイルは Caddy フォールバック
  （バックエンド停止時）とも共用のため、稼働状態を断定しない中立な文言とした。
- API のルート・エラー形式・not-found ハンドラは一切変更なし。

## 2026-07-17 — 本番起動（pm2 で常時稼働化）

Flutter クライアントの実機テスト開始に伴い、未起動だったバックエンドを起動した。

- **pm2 で常時稼働**（プロセス名 `mimamori-server`、`NODE_ENV=production`、`pm2 save` 済み）。
  このマシンは sudo 不可で systemd を使えないため、他サービスと同じ pm2 方式を採用。
  `deploy/mimamori-server.service` は sudo 取得後の理想形として残置。
- `npm run build` で dist を最新化してから起動。判定ジョブ5個が稼働、`/healthz` は 200 `ok`。
- **FCM は no-op ドライバで起動している**（`.env` の `FIREBASE_CREDENTIALS_PATH` が
  コメントアウトのまま）。API・判定エンジンは全機能動作するが、**プッシュ通知は実際には
  送信されない**。実機へのテスト push・本番通知には Firebase 認証情報の設定が必須。
- Twilio（ownerプランSMS）も未設定のため SMS フォールバックは無効。
- 運用手順は `doc/operations.md`「現在の本番運用: pm2」を参照。

## 2026-07-17 — FCM data payload に `client_name` 追加（Flutter連携）

mimamori-flutter チームとの API 突き合わせによる依頼2点への対応。

### 依頼1（実装）: ウォッチャー宛 push に `client_name` を追加

ウォッチャー端末がバックグラウンド／起動直後にプッシュを受けたとき、API 照会なしに
「誰の」通知かを表示できるようにするため、`data` に `client_name`（クライアントの
`display_name`）を載せた。対象 kind: `watch` / `alert` / `sos` / `permission`。

- 変更は `src/notify/dispatcher.ts` の data 引数のみ。各関数は元々 display_name を
  取得済みで追加クエリは不要。判定エンジン・状態遷移・通知の送信ロジックは無改修
- **`outage` は対象外**。サービス停止の一斉通知で特定クライアントに紐づかず、
  `client_id` すら持たないため `client_name` を付与できない（Flutter 側は汎用文言で表示）
- クライアント端末宛の `confirming` / `silent` にも不要
- プライバシー: `client_name` は既に通知 body（「◯◯さんの…」）に含まれる情報であり、
  ウォッチャーへの開示レベルは変わらない（原則2に抵触しない）

### 依頼2（確認）: `POST /v1/sos/:id/resolve` の空ボディ受理

`outcome` は optional（`z.enum([...]).optional()`）かつハンドラは `req.body ?? {}` で
受けるため、**ボディ省略・`{}` いずれも 400 にならず 200 `{ok:true}` を返す**ことを
`tests/api-contract.integration.test.ts` で回帰テスト化した。コード修正は不要だった。

## 2026-07-17 — GitHub 公開（アプリケーションコードの変更なし）

`https://github.com/murata1215/mimamori-server` へ初回コミット。**リポジトリは public**。
`src/` 配下の変更は0件。追加したのは `README.md`・`.env.example`・`.gitignore` の除外設定のみ。

### 公開から除外したものと理由

公開は git 履歴・GitHub のキャッシュ・fork に残り、あとから撤回できない。
一方あとから足すのはいつでもできる。よって判断が付かないものは「含めない」を選んだ。

- **`.devrelay-files/*-spec*.md`（一次情報の仕様書3点）** — 事業戦略・市場根拠を含むため除外。
  公開してよいかはユーザー未確認。公開する場合は `.gitignore` の該当行を消すだけでよい
- **`.devrelay/`（会話履歴 `conversation.json`）** — 公開すべきでないため除外
- **`.env`** — 実際のDBパスワードとJWT署名鍵が入っている。元から `.gitignore` 済み。
  push 前に、これらの値がコミット内容へ文字列として混入していないことを検索で確認した

`vitest.config.ts` の `*_WEBHOOK_SECRET` はテスト用ダミーであり、実鍵ではない。

### 補足

`.env.example` は `src/config.ts` の zod スキーマから全変数を起こしたもの。
`config.ts` を変更したら追随させること（起動時 fail fast の対象が増減するため）。

## 2026-07-17 — Phase 2（センサーアダプタ）

`mimamori-spec-server.md` §8「Phase 2 拡張インターフェース」の実装。

### アダプタ規約の検証結果（spec 8 の本題）

> 新ソースは「Webhook/ポーリング → events への正規化挿入」のみを実装する。
> 判定エンジン・状態遷移・学習・通知は無改修であること。

**SwitchBot・電力メーターの2ソースを追加して、`events` のスキーマ変更は0件だった。**
追加したのは逆引き表（`client_sensors`）とアダプタのみ。Phase 1 の抽象化は成立している。
（クロス判定は spec 5.2 が Phase 2 の判定仕様として最初から定めていたもので、
ソース追加に伴う改修ではない）

### 追加したソース

- SwitchBot 開閉センサー／スマートプラグ（confidence 100 = 生存イベント。即 ALIVE 復帰）
- 電力Bルート/電力会社API の30分値（confidence 70 = 弱シグナル。**ALIVE 復帰しない**）
- `has_app=false`（センサーのみ物件）の作成経路。判定エンジン側は Phase 1 で実装済みだった
- Twilio SMS ドライバ（ownerプラン。SDKではなく REST 直叩き = 依存を増やさない）

### 設計上の判断

- **低信頼ソースを生存イベントにしない**（`confidence < 80` は `last_alive_event_at` を更新しない）。
  spec 5.1 の生存イベント定義は `event_type` しか見ておらず、額面どおり実装すると
  **冷蔵庫のコンプレッサーが住人の死後も生存を証明し続け、デッドマンスイッチが永久に発報しない**。
  誤報より遥かに悪いため spec 8 の「低信頼ソースとして扱う」を優先した。
  副作用として電力メーター単体では見守りが成立しない（要オンボーディング明示。`doc/issues.md`）
- **クロス判定に上限（`CROSS_CHECK_HOLD_MINUTES` = 180分）を必ず設ける**。
  弱シグナルによる ALERT 保留を無制限にすると、上と同じ理由で検知漏れになる。
  誤報対策が検知漏れを生むのは本末転倒
- クロス判定は「本人確認を届けられない場合」に限定（端末沈黙 or `has_app=false`）。
  端末が生きているなら本人のタップの方が遥かに強い証拠であり、判定を鈍らせる必要がない
- **既に出した ALERT は弱シグナルで取り下げない**。解除はウォッチャーの resolve のみ
  （状態の巻き戻しは表示の信頼を損ない、誤報率KPIの計測基盤でもある）
- confidence は0-100の連続値だが、判定は「80以上か否か」の二値でしか解釈しない。
  ソース別の重み付け計算に発展させると、誤報の原因が後から追跡できなくなる
- confidence はサーバーが決める。登録・Webhook から指定できない
  （低信頼ソースが自分を高信頼と申告できてはならない。原則2と同じ理由）
- 1デバイス = 1クライアント（`source_id` に UNIQUE）。
  2人に紐づくと他人の生活シグナルが別人の判定に混ざる
- `has_app=false` の ALERT は「センサーの不具合の可能性」を併記。
  センサー故障と本人の異常を原理的に区別できないため断定しない
- センサー一覧に `last_event_at` を返さない。「玄関が最後に開いた時刻」は原則1が禁じる行動詳細。
  SQLで取得すらしない（別のレスポンスへ混入する余地を無くす）
- `events.meta` に `openState` を残さない。判定に要るのは「動きがあった」事実のみ

### 見つけて直した既存の問題

- **閾値学習テストが実行時刻依存だった** — テストデータの起点を `Date.now()` にしていたため、
  4時間バケットのどこに落ちるかで sample_count が半減し、実行する時刻によって成功/失敗が変わっていた。
  Phase 1 の「63件全合格」は、たまたま運のいい時刻に実行していただけ。JST 0時固定に修正
- **テストが型チェックされていなかった** — `tsconfig.json` が `tests/` を除外していたため、
  判定エンジンの入力型にフィールドを追加してもテストは `undefined` を渡したまま緑になる状態だった。
  `tsconfig.test.json` を追加して `npm run typecheck` に含めた（追加直後に実際の乖離を検出）
- センサー統合テストでウォッチャーのFCMトークン未登録により、
  「ALERTが飛ばないこと」の検証が無条件に成功していたのを修正

### 検証

- テスト106件（判定ロジック58 + 実DB統合48）— 全合格
- SwitchBot webhook → WATCH から ALIVE 復帰を実DBで実測（判定エンジン無改修）
- 電力の弱シグナルで ALIVE 復帰しないこと、クロス判定の保留と**上限超過での発報**を実測
- `npm audit`: critical 0 / high 0（Phase 2 で依存追加なし）

## 2026-07-16 — Phase 1 (MVP) サーバー実装

`mimamori-spec.md` / `mimamori-spec-server.md` に基づく初期実装。

### 判定エンジン（コア）

- 状態遷移: ALIVE →(閾値×0.8) WATCH →(閾値) CONFIRMING →(30分無応答) ALERT。生存イベントで即 ALIVE 復帰
- **「端末が生きている」と「本人が生きている」の区別**: `screen_on_count > 0 || had_app_usage` のHBのみ生存イベント扱い。操作0のHBは経過時間のカウントを継続
- 閾値学習: 曜日×4h帯の生存イベント間隔 p99 + マージン2h、6-24hでクランプ、サンプル不足はデフォルトへフォールバック
- silent push: 閾値50%で端末を起こす（多重送信防止つき）
- 端末沈黙（HB途絶45分）とALERT文言の切り替え（電池切れの可能性を明示）
- `has_app=false`（センサーのみ）プロファイル: CONFIRMINGをスキップし猶予後ALERT

### API

- ウォッチャー登録/ログイン/リフレッシュ、ペアリング（6桁・TTL15分・使い捨て）
- ハートビートのバッチ受付（冪等・未来時刻の丸め）、SOS、本人確認、権限申告
- ウォッチャー参照（一覧・遷移履歴・SOS詳細・解決）、オーナープラン（ダッシュボード・CSV・稼働レポート）
- RevenueCat webhook、SwitchBot webhook（署名検証まで実装・正規化はPhase 2で501）

### プライバシー・セキュリティ

- ウォッチャー向けレスポンスを zod スキーマで固定。ステータスと `status_changed_at` 以外は構造的に返らない
- 位置情報は `sos_incidents` にのみ保存。SOS以外の受け取り経路なし。30日で物理削除。resolve後は404
- device / watcher のトークンを分離し、互いのAPIを叩けないよう強制
- 全ウォッチャーAPIで `watch_links` を検証（IDOR対策）。権限なしは存在を漏らさないため404
- パスワードは scrypt（ネイティブ依存なし）。ログイン応答時間を揃えてユーザー列挙を防止
- ログから Authorization / password / 位置情報を redact
- `@fastify/jwt` の critical 脆弱性（認証バイパス・アルゴリズム混同）を 10.2.0 で解消。署名アルゴリズムを HS256 に固定

### 可用性

- `/healthz` は「見守りが機能しているか」を返す（DB＋判定ジョブ10分停止で503）。`/livez` は生存のみ
- 停止30分超で復旧時に全ウォッチャーへ「監視が◯時間停止していました」を通知（黙って再開しない）
- systemd ユニット（Restart=always、グレースフルシャットダウン、権限最小化）

### 設計上の判断

- **TZ を Asia/Tokyo に明示固定**（`src/lib/timezone.ts`）。学習側SQL（`EXTRACT`）と判定側JS（`getHours`）が
  環境TZ任せだとバケットが食い違い、誤った閾値が適用される。生活サイクルは本質的に現地時刻に紐づく
- 判定用の `last_alive_event_at` 等を `clients` へ非正規化。毎分×全件で events を集約するのは非現実的
- `events` に DEFAULT パーティションを用意。範囲外INSERTでハートビートを取りこぼすことは見守りの穴に直結する
- 状態遷移をDB反映してから通知。通知失敗で遷移が失われるより、状態が正しい方を優先（失敗は監査ログに残る）
- 判定は1クライアントずつ try/catch。1人の見守りが壊れて全員が止まるのを防ぐ

### 検証

- テスト63件（判定ロジック36 + 実DB統合27）— 全合格
- E2E 25項目（登録→ペアリング→HB→SOS→解決）— 全合格
- デッドマンスイッチを実DBで実測: ALIVE→WATCH→CONFIRMING→ALERT、本人確認による復帰
- `/healthz` の503→自動復帰を実測
