# rhbot — Robinhood Chain ミームコイン スパイク検知ボット

Robinhood Chain（Ethereum L2 / Arbitrum Orbit、DexScreener 上の chainId は `robinhood`）のミームコインを
DexScreener API で監視し、次の 2 種類のイベントを **Telegram** に通知します。

| 種類 | 条件（デフォルト値） |
| --- | --- |
| 🚀 **新規ローンチ** | ペア作成から **20h 以内** に **1h 出来高が $25K / $100K / $500K** の各段階を超えた（各段階 1 回ずつ通知） |
| 🔥 **復活スパイク（最重要）** | ペア作成から **20h 以上** 経過し、**1h 出来高が直前 23h の平均 1h 出来高の 3 倍以上**（突発的な出来高）かつ **価格が +30% 以上**（DexScreener の 1h 変化率、または自前スナップショットの 2h 安値比） |

どちらも流動性 $5K 未満、買い件数が少なすぎるペア（単発の wick）は除外します。しきい値はすべて `.env` で変更できます。

---

## 仕組み

```
┌──────────────────────── 監視対象の発見 ────────────────────────┐
│ ① DexScreener /latest/dex/search   (クエリ × 最大30件, chainId で絞る) │
│ ② DexScreener /token-pairs/v1      (WETH 等の quote トークンの全プール)   │
│ ③ DexScreener token-profiles/boosts (宣伝・ブースト中トークン)            │
│ ④ チェーン RPC eth_getLogs          (Uniswap V2/V3/V4 のプール作成イベント)│
└───────────────────────────────┬────────────────────────────────┘
                                ▼
                 SQLite (pairs / snapshots / alerts)
                                │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
   hot (45s 更新)        dormant (4min 更新)        dead (30min 更新)
   直近に出来高あり/新規    低迷中 ← 復活検知の主戦場    流動性ほぼゼロ
        └───────────────────────┼────────────────────────┘
                                ▼
              detectors: newLaunch / revival → Telegram
```

- **RPC 監視 (④)** は DexScreener の search が 30 件までしか返さない弱点を補うためのものです。
  ファクトリのイベントを直接読むので、どの DEX（Uniswap 系フォーク含む）でも新規プールを作成直後に検知できます。
  見つけたプールは DexScreener にインデックスされ次第、監視対象に入ります。
- **dormant ペアも定期的に更新し続ける** ことが復活検知の要です。流動性が残っている限り監視から外しません。
- 同じトークンに複数ペア（WETH / USDC 等）があっても通知はトークン単位で 1 回です。

---

> 🔰 **パソコンやターミナルに慣れていない方へ**
> インストールから Telegram 接続まで、画面のどこを押すかまで含めた手順書があります → **[SETUP.md](./SETUP.md)**

---

## セットアップ

必要なもの: **Node.js 22.13 以上**（`node:sqlite` を使うため。外部の DB 不要）

```bash
git clone https://github.com/cony-horizon/rhbot.git
cd rhbot
npm install
cp .env.example .env
```

### 1. Telegram ボットを作る

1. Telegram で [@BotFather](https://t.me/BotFather) に `/newbot` → トークンを取得 → `.env` の `TELEGRAM_BOT_TOKEN` に設定
2. 作ったボットに何か話しかける（グループで使うならグループに追加して話しかける）
3. ブラウザで `https://api.telegram.org/bot<トークン>/getUpdates` を開き、`"chat":{"id":123456789` の数字を `TELEGRAM_CHAT_ID` に設定
   （グループは負の数になります。複数はカンマ区切り）

### 2. 疎通確認

```bash
npm run probe -- telegram   # テストメッセージが届けば OK
npm run probe               # DexScreener 検索・トークンプール・RPC の疎通と取得件数を表示
```

> `tsx: command not found` が出た場合は、同じコマンドをもう一度実行してください。
> 各 npm script の先頭に `scripts/preflight.mjs` が入っており、依存パッケージの欠落を検出して
> `npm install --include=dev` で自動復旧します。

### 3. 起動

```bash
npm run dev      # 開発（ファイル変更で自動再起動）
# または
npm run build && npm start
```

Docker の場合:

```bash
docker compose up -d --build
docker compose logs -f
```

VPS で常駐させるなら `pm2 start npm --name rhbot -- start` か上記 Docker を推奨します。

---

## Telegram コマンド

| コマンド | 説明 |
| --- | --- |
| `/status` | 監視ペア数（hot/dormant/dead）、直近 24h のアラート数、RPC ブロック、API 使用量 |
| `/top [n]` | 1h 出来高上位ペア |
| `/alerts [n]` | 直近のアラート履歴 |
| `/test` | 通知の見本を送る。監視中ペアの実データを使うので、配信経路と表示の両方を確認できる |
| `/watch <アドレス>` | ペア or トークンアドレスを手動で監視追加（自動削除されません） |
| `/unwatch <アドレス>` | 監視から外す |
| `/list` | 手動監視中の一覧 |
| `/mute [分]` / `/unmute` | 通知を一時停止 / 再開（検知は継続し `/alerts` に残ります） |
| `/config` | 現在の検知しきい値 |

`TELEGRAM_CHAT_ID` に含まれない chat からのコマンドは無視されます。

### 自己診断

「通知が来ない」が正常（市場が静か）なのか異常（設定ミス・API 変更）なのかは利用者から見分けが
つかないため、対象チェーンのペアを 5 回連続で 1 件も取得できなかった場合、ボット自身が Telegram に
警告を送ります（同じ警告は 6 時間に 1 回まで）。

`npm run probe` は、`CHAIN_ID` に一致するペアが 0 件だったとき、実際に返ってきた chainId の一覧を
出力します。DexScreener 側でチェーン名が変わっても、そこから正しい値が分かります。

---

## チューニングガイド

`.env` を編集して再起動すると反映されます。主なノブ:

### 復活スパイク（🔥）

| 変数 | 既定 | 上げると | 下げると |
| --- | --- | --- | --- |
| `REVIVAL_PRICE_CHANGE_PCT` | 30 | 通知が減る、確度が上がる | 早く気づけるがノイズ増 |
| `REVIVAL_VOL_SPIKE_RATIO` | 3 | 「本当に突発」なものだけ | じわ上げも拾う |
| `REVIVAL_MIN_VOL_H1_USD` | 10000 | 小型を除外 | 小型も拾う |
| `REVIVAL_LOOKBACK_MIN` | 120 | ゆっくりした上昇も拾う | 直近の急騰のみ |
| `REVIVAL_MIN_AGE_HOURS` | 20 | 新規ローンチとの境界 | — |
| `REVIVAL_COOLDOWN_MIN` | 180 | 同一銘柄の連投を抑える | — |
| `REVIVAL_ESCALATION_PCT` | 50 | クールダウン中でも更に +50% で再通知（0 で無効） | — |

「30〜40% 以上」を確実に拾いたいなら `REVIVAL_PRICE_CHANGE_PCT=30` のまま、ノイズが多ければ 40 に。
ローンチ直後の乱高下を復活扱いしたくない場合は `REVIVAL_MIN_AGE_HOURS` を 24〜36 に上げてください。

### 新規ローンチ（🚀）

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `NEW_VOL_H1_TIERS_USD` | 25000,100000,500000 | 各段階を超えるたびに 1 回通知。1 段階だけにしたければ `50000` のように 1 つだけ書く |
| `NEW_MAX_AGE_HOURS` | 20 | これ以降は復活検知側に引き継ぐ |
| `NEW_MIN_BUYS_H1` | 15 | 買い件数の下限（bot 1 件の大口だけ、を除外） |

### 共通

- `MIN_LIQUIDITY_USD` (5000): 流動性下限。ラグ・ハニーポットの多くはこれで落ちます
- `QUOTE_SYMBOLS`: `WETH` などに絞ると USDC ペア等を無視
- `DORMANT_POLL_INTERVAL_SEC` (240): 復活検知の反応速度。小さくすると API 消費が増えます

### API 使用量の目安

DexScreener 無料 API は **300 req/分**（search / pairs / tokens）と **60 req/分**（profiles / boosts）。
ペア更新は 30 件 / 1 リクエストなので、hot 300 ペア + dormant 3000 ペアでも
毎分 20 リクエスト程度に収まります。`/status` の「DexScreener リクエスト累計」で確認できます。

### RPC について

`RPC_URL` 既定の公式パブリック RPC（`https://rpc.mainnet.chain.robinhood.com`）は bot 向けに保証されていないため、
429 が出る場合は `RPC_BLOCK_CHUNK` を下げるか `RPC_SCAN_INTERVAL_SEC` を上げるか、
[GetBlock](https://docs.getblock.io/api-reference/robinhood) 等のプロバイダの URL に差し替えてください。
RPC を使いたくない場合は `RPC_URL=` と空にすると DexScreener のみで動作します（新規ローンチ検知の網羅性は落ちます）。

---

## 開発

```bash
npm test          # vitest（検知ロジック / RPC パース / API クライアント / エンジンの統合シナリオ）
npm run typecheck
```

```
src/
  index.ts          エントリ。スケジューラと Telegram コマンド
  engine.ts         発見 → 更新 → 検知 → 通知 のコアロジック
  detectors/        newLaunch.ts / revival.ts（純関数、テスト容易）
  dexscreener.ts    API クライアント（レート制限・リトライ・30件分割）
  rpc.ts            eth_getLogs でプール作成イベントを追跡
  store.ts          node:sqlite ストア（pairs / snapshots / alerts / pending）
  telegram.ts       Bot API 送信 + getUpdates ロングポーリング
  format.ts         通知メッセージの整形
  tools/probe.ts    疎通確認 CLI
```

## 既知の制約

- DexScreener の `search` は全チェーン横断で最大 30 件しか返しません。`DISCOVERY_SEARCH_QUERIES` を増やす、
  `DISCOVERY_TOKEN_ADDRESSES` に主要 quote トークンを列挙する、RPC 監視を有効にする、の 3 つで補っています。
- pump.fun 型ローンチパッド（ボンディングカーブ）上のトークンは DEX にマイグレーションされるまで RPC 監視には現れません。
  DexScreener がそれらを掲載していれば search / profiles 経由で拾えます。
- DexScreener 側で価格 (`priceUsd`) や `pairCreatedAt` が欠けているペアは対象外になります。
- 本ツールは通知のみで売買は行いません。投資判断は自己責任でお願いします。
