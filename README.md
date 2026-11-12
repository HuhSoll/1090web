# 1090web

世界の航空ネットワークを、地図の上に光の線として描くWebアプリです。平面地図と3Dの地球儀を切り替えて見られます。

空港を選ぶとそこから伸びる路線だけが浮かび上がり、国や航空会社、旅客／貨物、便数で絞り込みながらネットワークの形を眺められます。月ごとのデータを切り替えたり、自動再生して変化を追ったりもできます。

2つの月を比べると、路線ごとの増減が色で表示されます（青が増加、オレンジが減少）。観測できた日数は月によって違うので、比較は1日あたりの便数で行います。見ている月・比較・絞り込み・選んだ空港は URL に残るので、そのまま共有できます。

「安全情報」をオンにすると、EASA（欧州航空安全機関）が出している紛争地域の注意喚起を、その月に有効だった国に重ねて表示します。注意喚起は運航停止を意味しないので、路線の表示は変えていません。

データは、ADS-B（航空機が発信する位置情報）の受信記録から作られた 2026年1〜9月の便データを月ごとに集計したものです。公式の時刻表ではなく、受信網が手薄な地域では観測できない便があります。空港を航跡から確認できなかった便は「便名から推定」として区別し、画面で切り替えられます。データの作り方と品質は [docs/pipeline.md](docs/pipeline.md) にまとめています。

## 研究モード

画面右上の「研究」に切り替えると、観測された航空ネットワークを条件を決めて分析できます。

- 月、国・地域、空港、航空会社コード、機材の分類、月間便数の下限、観測された月数、空港判定の根拠（T1〜T4）、有向／無向を指定
- 次数、重み付き次数、媒介中心性、調和近接中心性、PageRank、連結成分、密度、クラスタ係数を計算（Web Worker で計算するので画面は止まりません）
- 空港・路線のランキング、国・地域の集計、月や閾値・根拠区分・地域を1つ変えた比較（順位の相関、上位20の一致率）
- データ品質（収集停止、異常日、根拠の構成）と、米国・ブラジル・日本の公式統計との条件付きの照合結果を表示
- 結果を CSV、条件と出典を JSON で保存。JSON や URL から同じ条件を復元できます

時間軸のデータ（2026年1〜9月の UTC の日ごと）も用意しています。任意の日・1時間・6時間などの時間窓で、その間に記録が始まった便（航跡の開始時刻、なければ終了時刻）のネットワークを作れます。画面での利用は今後のフェーズで実装します（形式は [docs/temporal-data-model.md](docs/temporal-data-model.md)）。

値はすべて ADS-B で観測できた便のネットワークの構造指標で、旅客数や経済的な重要度ではありません。指標の定義は [docs/research-methodology.md](docs/research-methodology.md)、外部統計との照合は [docs/phase7-report.md](docs/phase7-report.md) にあります。


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
- `public/data/observed-2026-v2/`（既定）と `public/data/observed-2026/`（旧版）の集計データは、上記の派生データベースとして ODbL-1.0 で提供します（詳細は [DATA_LICENSE.md](DATA_LICENSE.md)）

## ライセンス

コードは [MIT License](LICENSE)、データはそれぞれの出典の条件に従います（[DATA_LICENSE.md](DATA_LICENSE.md)）。
