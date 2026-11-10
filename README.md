# AeroGraph

世界の航空ネットワークを、地図の上に光の線として描くWebアプリです。平面地図と3Dの地球儀を切り替えて見られます。

空港を選ぶとそこから伸びる路線だけが浮かび上がり、国や航空会社、旅客／貨物、便数で絞り込みながらネットワークの形を眺められます。月ごとのデータを切り替えたり、自動再生して変化を追ったりもできます。

いまは開発の初期段階で、表示しているデータはUIと描画を作るためのサンプルです。路線や便数、航空会社は自動生成したもので、実在の統計ではありません（画面上にもそう表示しています）。実際のフライトデータへの置き換えはこれから進めます。

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

- 実際のフライトデータ（ADS-B観測データ）への置き換え
- 月ごとのネットワークの比較
- 航空当局の公式情報をもとにしたインシデント表示

## データ・クレジット

- 地図：Natural Earth（[world-atlas](https://github.com/topojson/world-atlas) 経由）
- 予定しているデータソース：[aircraft-flight-schedules](https://github.com/MrAirspace/aircraft-flight-schedules)、[OurAirports](https://ourairports.com/data/)
