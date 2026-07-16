import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * テスト専用の環境変数。
     *
     * Webhook の署名検証は「シークレット未設定なら503」で正しく閉じているため、
     * 検証経路をテストするには値が要る。ここで注入する。
     *
     * dotenv は既存の process.env を上書きしないので、この値が .env より優先される。
     * 本番のシークレットがテストで使われることはない。
     */
    env: {
      SWITCHBOT_WEBHOOK_SECRET: 'test-switchbot-secret-do-not-use-in-production',
      POWER_METER_WEBHOOK_SECRET: 'test-power-meter-secret-do-not-use-in-production',
    },
    /**
     * 統合テストは同一DBの同じテーブルを触るため、ファイル間の並列実行を禁じる。
     * 特に判定ジョブ（runEvaluation）は全クライアントを走査するので、
     * 並列に走ると他ファイルのテストデータを巻き込んで判定してしまう。
     */
    fileParallelism: false,
  },
});
