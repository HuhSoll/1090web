# AeroGraph

> Explore the world's aviation network.

> [!NOTE]
> この README は暫定版です。公開前に手直しします。

AeroGraph は、世界の航空ネットワークを数千〜数万本の光の曲線として 3D 地球儀上に可視化するインタラクティブ Web アプリです。

**現在の状態：Phase 1（基盤構築と 3D 表示プロトタイプ）**
表示されている路線・航空会社・便数はすべて **合成デモデータ** です。実際の航空統計ではありません。

---

## ローカル実行

必要環境：Node.js 20.19 以上（22 推奨）

```bash
npm install
npm run dev          # http://localhost:5173
```

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` | 型チェック + 本番ビルド（`dist/`） |
| `npm run preview` | ビルド結果のローカル配信 |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 型チェック |
| `npm test` | Vitest によるユニットテスト |
| `npm run check` | lint + typecheck + test + build |
| `npm run data:demo` | デモデータの再生成（`public/data/demo/`） |

### 描画負荷テスト

`http://localhost:5173/?stress=50000` で、ランダムな 50,000 路線（最大 100,000）を生成して描画性能を確認できます。画面上に「負荷テスト」と明示されます。

### GitHub Pages のサブパス確認

```bash
BASE_PATH=/AeroGraph/ npm run build
BASE_PATH=/AeroGraph/ npx vite preview   # http://localhost:4173/AeroGraph/
```

Windows の Git Bash では `MSYS_NO_PATHCONV=1` を先頭に付けてください（パス変換を防ぐため）。

---

## アーキテクチャ

```
src/
  app/            アプリのエントリ、データ読み込みフック、設定
  data/
    model/        公開データのスキーマ（schema.ts）とメモリ上のモデル（network.ts）
    loaders/      fetch・ランタイム検証・データセットローダー
    demo/         描画負荷テスト用の生成器
  domain/         フィルタリング・集計・検索（純粋関数、React/Three 非依存）
  render/
    globe/        Three.js レンダラー（React 非依存の命令型クラス）
    shaders/      GLSL
  components/     React UI（layout / controls / panels / globe / common）
  i18n/           日本語・英語の辞書と Intl ベースの書式化
  state/          zustand ストア
  utils/          地理計算
scripts/          データ生成スクリプト
public/data/      公開用の集計済みデータ（データセットごと）
tests/            Vitest
```

### データの流れ

```
public/data/<dataset>/        DatasetLoader         domain/networkView       GlobeRenderer
  manifest.json          ──►  検証・インデックス化 ──► フィルター適用        ──► GPU テクスチャ更新
  airports.json               （静的データは1回）       （Float32Array を返す）
  routes.json
  months/YYYY-MM.json    ──►  必要な月だけ取得・キャッシュ
```

- **空港データ / 路線データ / 月次集計データ** はファイルとして分離。路線（空港ペア）の集合は `routes.json` に一度だけ定義し、月次ファイルは路線 ID を参照します。
- **フィルタリング**（`src/domain/networkView.ts`）は純粋関数で、路線 ID・空港インデックスで引ける型付き配列を返します。
- **3D 描画**（`src/render/`）はデータセットや React を知らず、型付き配列と選択状態だけを受け取ります。
- `manifest.kind` が `demo` か `observed` かで UI がデモ表示を切り替えます。データソースの交換は `VITE_DATASET_ID` で行えます。

### 描画方式（パフォーマンス設計）

- **全路線を 1 ドローコール**：共有の 32 分割テンプレート線を `InstancedBufferGeometry` でインスタンス化し、大圏弧の形状は頂点シェーダーで計算。1 路線あたりのメモリは端点 24 byte + 状態 4 byte。
- **フィルター・月切替・選択は頂点バッファを触らない**：路線ごとの重み・ハイライト状態を RGBA テクスチャに書き込み、`gl_InstanceID` で参照。
- **加算合成** で路線が密な地域ほど明るくなり、路線数に応じて全体の不透明度を自動調整（飽和防止）。地平線付近の弧は減光。
- 選択空港の接続路線（通常数百本以下）のみ CPU で太線（`LineSegments2`）を生成。路線のホバー判定もこの小集合に限定。
- 空港は 1 つの `Points` ドローコール。ホバー判定は画面空間の最近傍探索。
- 変化がないフレームは描画しない（オンデマンドレンダリング）。

実測（開発環境・1440×900）：50,000 路線で 1 フレーム約 10 ms、7 ドローコール。

---

## データについて

### Phase 1（現在）：デモデータ

- `public/data/demo/` は `scripts/generate-demo-data.mjs` で生成した **合成データ** です。
- 空港の位置は実在空港の概略座標（手入力）ですが、路線・便数・分類は乱数生成です。
- 航空会社は実在企業と誤認されないよう、すべて架空（`Demo …`）です。
- UI 上部のバナー、各パネルのバッジ、「データと出典」ダイアログでデモデータであることを明示しています。

### Phase 2 以降：実データ（予定）

- 便データ：[MrAirspace/aircraft-flight-schedules](https://github.com/MrAirspace/aircraft-flight-schedules)（ADS-B 観測由来。公式時刻表ではありません）
- 空港データ：[OurAirports](https://ourairports.com/data/)
- 地図：Natural Earth（[world-atlas](https://github.com/topojson/world-atlas) 経由、パブリックドメイン）

各ソースのライセンス条件は Phase 2 で確認し、出典表示に反映します。

---

## 実装状況

| # | 機能 | 状態 |
| --- | --- | --- |
| 1 | マウス操作可能な 3D 地球儀 | ✅ |
| 2 | 月次航空ネットワークの表示 | ✅（デモデータ） |
| 3 | 全路線の低透明度描画 | ✅ |
| 4 | 空港の検索・選択 | ✅ |
| 5 | 選択空港の接続路線の強調 | ✅ |
| 6 | 国別絞り込み | ✅ |
| 7 | 航空会社別絞り込み | ✅（架空の航空会社） |
| 8 | 旅客＋貨物／旅客のみ | ✅（分類不明は旅客のみモードで除外） |
| 9 | 月間便数の閾値 | ✅ |
| 10 | 路線・空港の情報パネル | ✅ |
| 11 | 月別データの切り替え | ✅ |
| 12 | 月次ネットワークの比較 | ⏳ Phase 3 |
| 13 | 月の自動再生 | ✅ |
| 14 | 日本語・英語の切り替え | ✅ |
| 15 | データソースと観測期間の表示 | ✅（デモ用の内容） |
| 16 | インシデント情報のオーバーレイ | ⏳ Phase 4 |

未実装機能は UI 上で「未実装」と表示し、操作できないようにしています。

---

## デプロイ

`.github/workflows/deploy.yml` が `main` への push で lint・型チェック・テスト・ビルドを行い、GitHub Pages にデプロイします（PR ではチェックのみ）。リポジトリの Settings → Pages で Source を「GitHub Actions」に設定してください。ビルド時に `BASE_PATH=/<リポジトリ名>/` が自動設定されます。
