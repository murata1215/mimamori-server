# mimamori-server 運用ガイド

## 起動・停止

```bash
npm run migrate        # マイグレーション（冪等。未適用のみ適用）
npm run dev            # 開発（tsx watch）
npm run build && npm start   # 本番相当
```

### 現在の本番運用: pm2（sudo 不可の testflight 環境）

このマシンでは root 権限が無く systemd を使えないため、他サービスと同じく **pm2** で常時稼働させている。

```bash
npm run build          # dist/ を最新化してから
NODE_ENV=production pm2 start dist/index.js --name mimamori-server --time
pm2 save               # マシン再起動時の復元リストへ登録
pm2 logs mimamori-server   # ログ確認
pm2 restart mimamori-server   # コード更新後（build 後）に反映
```

- `.env` は cwd（プロジェクトルート）から dotenv が読むため、pm2 起動時も追加設定は不要。
- **コード変更を反映するには `npm run build` → `pm2 restart mimamori-server` が必要**（pm2 は dist/ を実行するため、tsx watch のような自動反映はされない）。
- Restart ポリシー（プロセス死亡時の自動復帰）は pm2 が担う。systemd の `Restart=always` 相当。

### systemd 運用（sudo 取得後の理想形。未使用）

```bash
sudo cp deploy/mimamori-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mimamori-server
journalctl -u mimamori-server -f
```

## 外形監視（必須要件）

**このサービスは自分自身の沈黙を許されない**（spec 7.3）。以下を必ず設定する。

| 項目 | 値 |
|---|---|
| 監視URL | `https://mimamori-server.devrelay.io/healthz` |
| 間隔 | 1分 |
| 期待 | HTTP 200 |
| 異常時 | 管理者（けいすけ）へ LINE/Discord 通知 |

`/healthz` は **「サーバーが応答するか」ではなく「見守りが機能しているか」** を返す。

- DB接続不可 → 503
- 判定ジョブが10分以上停止 → 503（`HEALTH_JOB_STALL_MINUTES` で調整可）
- 起動直後（10分以内で未実行）→ 200 `status: starting`

`/livez` はプロセス生存のみ。**外形監視に使ってはならない**（判定ジョブが死んでも200を返すため）。

### 停止後の復旧時の挙動

判定ジョブの空白が **30分以上** の場合、起動時に検知して全ウォッチャーへ
「見守りが約◯時間停止していました」を通知する（黙って再開しない = 信頼の担保）。
30分未満はデプロイ・再起動の範囲とみなし通知しない（狼少年化の防止）。

## ジョブ一覧

| ジョブ | スケジュール | 内容 | 止まると何が起きるか |
|---|---|---|---|
| evaluator | 毎分 | 判定ジョブ | **見守りが止まる**（/healthz が503） |
| threshold | 毎日 03:00 | 閾値学習 | 閾値がデフォルトのまま（安全側） |
| sos_purge | 毎日 04:00 | 位置情報の物理削除 | 位置が30日を超えて残る（プライバシー違反） |
| partition | 毎日 02:00 | パーティション先行作成 | 翌月分がDEFAULTへ流入（性能劣化） |
| kpi_summary | 毎日 09:00 | KPI集計 | Phase 1 の合否判定ができない |

TZ は全て `Asia/Tokyo` 固定（`src/lib/timezone.ts`）。

## 環境変数

`.env` に設定。`src/config.ts` が起動時に検証し、不正なら**起動を中止する**（fail fast）。

必須:
- `DATABASE_URL` — PostgreSQL 接続文字列
- `PORT` — 9021
- `JWT_SECRET` — 32文字以上。**ローテーションすると全トークンが失効し、全クライアント端末の再ペアリングが必要になる**

未設定でも起動するが機能が無効化されるもの:
- `FIREBASE_CREDENTIALS_PATH` — **未設定だと通知が一切飛ばない**（no-opドライバ）。本番では必須
- `REVENUECAT_WEBHOOK_SECRET` — 未設定だと webhook が503（誰でも課金状態を書き換えられる状態は作らない）
- `SWITCHBOT_WEBHOOK_SECRET` — 未設定だと SwitchBot webhook が503
- `POWER_METER_WEBHOOK_SECRET` — 未設定だと電力メーター webhook が503
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` — ownerプランのSMS。
  **3つ揃っていないと起動しない**（中途半端な設定で「送れたつもり」になるのを防ぐため、
  全部設定か全部未設定のみ許可）。未設定なら SMS は送られず、監査ログには失敗として残る

判定パラメータ（誤報率を見ながら再デプロイなしで調整可能）:

| 変数 | 既定 | 意味 |
|---|---|---|
| `DEFAULT_THRESHOLD_MINUTES` | 900 (15h) | コールドスタート時の閾値 |
| `FREQUENT_THRESHOLD_MINUTES` | 600 (10h) | 「よく触る」自己申告時 |
| `MIN_THRESHOLD_MINUTES` | 360 (6h) | 学習値の下限（暴走防止） |
| `MAX_THRESHOLD_MINUTES` | 1440 (24h) | 学習値の上限 |
| `THRESHOLD_MARGIN_MINUTES` | 120 | p99 に加算するマージン |
| `MIN_SAMPLE_COUNT` | 20 | 学習に必要な最低サンプル数 |
| `CONFIRMING_TIMEOUT_MINUTES` | 30 | 本人確認の無応答タイムアウト |
| `ALERT_RENOTIFY_HOURS` | 24 | ALERT の再通知間隔 |
| `SOS_PURGE_DAYS` | 30 | 位置情報の保持日数 |
| `NO_APP_GRACE_MINUTES` | 60 | センサーのみクライアントの WATCH→ALERT 猶予 |
| `WEAK_SIGNAL_FRESH_MINUTES` | 90 | 弱シグナルを「新しい」とみなす時間（Phase 2） |
| `CROSS_CHECK_HOLD_MINUTES` | 180 | **クロス判定がALERTを保留できる上限**（Phase 2） |

### クロス判定と `CROSS_CHECK_HOLD_MINUTES`（Phase 2・要注意）

端末が沈黙している（＝本人確認を届けられない）とき、電力メーターのような
低信頼ソースが動いていれば ALERT を保留し WATCH 止まりにする（spec 5.2）。
「スマホの電池が切れただけの元気な親に警告が飛ぶ」誤報を減らすのが目的。

**`CROSS_CHECK_HOLD_MINUTES` を無効化・極端に大きくしてはならない。**
弱シグナル（家全体の電力変動）は本人が倒れていても発生し続ける。冷蔵庫・給湯器・
待機電力は住人の生死と無関係に動くため、上限が無いとデッドマンスイッチが
**永久に発報しなくなる**。誤報対策が検知漏れを生むのは本末転倒であり、
「見守っているつもりで誰も見ていない」状態はこのサービスで唯一許されない失敗。

保留の効果は監査ログで追える:
```sql
SELECT detail->>'reason', COUNT(*) FROM audit_log
 WHERE event='status_change' AND detail->>'reason' LIKE 'cross_check%'
 GROUP BY 1;
```

## バックアップ

日次 pg_dump ＋ オフサイト（2層構成）。

**位置情報のpurgeはバックアップにも適用する**: purge済みデータを含む世代は30日で破棄すること。
これを守らないと、DB上は消えている位置情報がバックアップに残り続ける。

## トラブルシューティング

### /healthz が503

```bash
journalctl -u mimamori-server -n 100 --no-pager
psql "$DATABASE_URL" -c "SELECT * FROM job_runs;"   # 最終実行時刻
```

`last_status = 'partial_failure'` なら一部クライアントの判定が失敗している。
`detail` に件数が入る。個別のエラーは journald に出る。

### 通知が飛ばない

```bash
journalctl -u mimamori-server | grep 'fcm:noop'   # FCM未設定
psql "$DATABASE_URL" -c "SELECT event, detail FROM audit_log WHERE event='notification_failed' ORDER BY created_at DESC LIMIT 20;"
```

### イベントが DEFAULT パーティションに溜まっている

パーティション運用の異常サイン。

```sql
SELECT COUNT(*) FROM events_default;   -- 0 であるべき
SELECT ensure_event_partitions();      -- 手動で確保
```

### センサーからイベントが届かない（Phase 2）

`GET /v1/clients/:id/sensors` は**行動情報を返さないため、センサーの死活は分からない**
（「玄関が最後に開いた時刻」は原則1により開示できない）。運用側はDBで見る。

```sql
-- センサーの登録状況と最終イベント（運用専用。APIでは返らない）
SELECT s.source_type, s.source_id, s.enabled, s.confidence, s.last_event_at
  FROM client_sensors s WHERE s.client_id = '...';
```

`last_event_at` が NULL のまま = 一度も届いていない。以下を順に確認する。

1. Webhook が401 → 署名鍵の不一致（`SWITCHBOT_WEBHOOK_SECRET`）
2. Webhook が404 → `source_id`（deviceMac）の登録漏れ、または `enabled=false`
3. Webhook が503 → シークレット未設定
4. 200 かつ `ignored: true` → 人の行動とみなさない状態変化のみ届いている

```bash
journalctl -u mimamori-server | grep -i switchbot
```

### 誤報が多い / 検知が遅い

```sql
-- 誤報率の確認
SELECT detail->>'false_alarm' AS false_alarm, COUNT(*)
  FROM audit_log
 WHERE event='status_change' AND detail->>'reason' LIKE 'watcher_%'
 GROUP BY 1;

-- あるクライアントの学習状況
SELECT dow, hour_bucket, p99_gap_minutes, sample_count
  FROM thresholds WHERE client_id = '...' ORDER BY dow, hour_bucket;
```

`sample_count` が20未満のバケットはデフォルト閾値で運用される（安全側）。
→ `doc/issues.md` の「学習成立条件」を参照。
