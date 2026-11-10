# 1090web

世界の航空ネットワークを、地図の上に光の線として描くWebアプリです。平面地図と3Dの地球儀を切り替えて見られます。

空港を選ぶとそこから伸びる路線だけが浮かび上がり、国や航空会社、旅客／貨物、便数で絞り込みながらネットワークの形を眺められます。月ごとのデータを切り替えたり、自動再生して変化を追ったりもできます。

2つの月を比べると、路線ごとの増減が色で表示されます（青が増加、オレンジが減少）。観測できた日数は月によって違うので、比較は1日あたりの便数で行います。見ている月・比較・絞り込み・選んだ空港は URL に残るので、そのまま共有できます。

「安全情報」をオンにすると、EASA（欧州航空安全機関）が出している紛争地域の注意喚起を、その月に有効だった国に重ねて表示します。注意喚起は運航停止を意味しないので、路線の表示は変えていません。

データは、ADS-B（航空機が発信する位置情報）の受信記録から作られた 2026年1〜9月の便データを月ごとに集計したものです。公式の時刻表ではなく、受信網が手薄な地域では観測できない便があります。空港を航跡から確認できなかった便は「便名から推定」として区別し、画面で切り替えられます。データの作り方と品質は [docs/pipeline.md](docs/pipeline.md) にまとめています。

UI 開発用のサンプルデータは `?dataset=demo` で表示できます。

## 動かし方

Node.js 20.19 以上が必要です。

```bash
npm install
npm run dev
```

`http://localhost:5173` で開きます。

その他のコマンド：

```bash
npm run build      # 本番ビルド
npm run check      # lint・型チェック・テスト・ビルドをまとめて実行
npm run data:demo  # サンプルデータを作り直す
```

実データの作り直し方は [docs/pipeline.md](docs/pipeline.md) を見てください（Python・DuckDB を使います）。

SNS用のプレビュー画像（`public/og-image.png`）の作り直し（Python・Pillow・numpy が必要）：

```bash
npm run og:geometry
python scripts/og/render-og.py og-geometry.json public/og-image.png
```

URL に `?stress=50000` を付けると、ランダムな5万路線で描画の重さを試せます。

## しくみ

- React + TypeScript + Vite、描画は Three.js（WebGL2）
- 路線はすべて1回の描画命令でまとめて描いています。曲線の形はGPU側で計算し、絞り込みや月の切り替えでは路線ごとの状態を小さなテクスチャに書き込むだけなので、数万本でも軽く動きます
- データは「空港」「路線」「月ごとの便数」に分けたJSONで、必要な月だけ読み込みます
- 絞り込みの計算、描画、UIはそれぞれ独立させていて、データの差し替えがしやすい構成にしています

```
src/
  data/       データの型と読み込み
  domain/     絞り込み・集計・検索
  render/     地図・地球儀と路線の描画
  components/ UI
  i18n/       日本語・英語
scripts/      サンプルデータの生成
public/data/  公開用データ
```

## これから

- 2026年10〜12月のデータ追加（元データの公開待ち）
- 航空会社名の表示
- 空域制限・気象警報の追加（使える公式データの調査中）

## データ・クレジット

- 地図：Natural Earth（[world-atlas](https://github.com/topojson/world-atlas) 経由）
- 便データ：[MrAirspace/aircraft-flight-schedules](https://github.com/MrAirspace/aircraft-flight-schedules)（ODbL-1.0）。元は [ADSBlol](https://github.com/adsblol) の受信データ、[vradarserver/standing-data](https://github.com/vradarserver/standing-data) の便名・路線データ、[adsbdb.com](https://www.adsbdb.com/) の機材データ
- 空港：[OurAirports](https://ourairports.com/data/)
- 安全情報：[EASA Conflict Zone Information Bulletins](https://www.easa.europa.eu/en/domains/air-operations/czibs)（© EASA、出典明記で再利用可）
- `public/data/observed-2026/` の集計データは上記の派生データベースとして ODbL-1.0 で提供します
