# データのライセンス

このリポジトリのコードとデータは、ライセンスが別々です。コード（`public/data/` 以外）は [MIT License](LICENSE) です。

## `public/data/observed-2026/`（ADS-B 観測データの集計）

[Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/) で提供します。

このデータは次の情報源から作った派生データベースです。ODbL の条件により、同じ ODbL で提供し、出典を明記しています。

- 便データ：[MrAirspace/aircraft-flight-schedules](https://github.com/MrAirspace/aircraft-flight-schedules)（ODbL-1.0）
  - 元データ：[ADSBlol](https://github.com/adsblol)、[vradarserver/standing-data](https://github.com/vradarserver/standing-data)、[adsbdb.com](https://www.adsbdb.com/)
- 空港の名称・座標：[OurAirports](https://ourairports.com/data/)（利用条件は確認中）

集計方法と品質は [docs/pipeline.md](docs/pipeline.md) にあります。公式の時刻表ではありません。

## `public/data/advisories/`（安全情報）

[EASA Conflict Zone Information Bulletins](https://www.easa.europa.eu/en/domains/air-operations/czibs) をもとにしています。
© European Union Aviation Safety Agency。出典を明記すれば再利用できます（EASA の著作権表示による）。

## `public/data/demo/`（デモデータ）

UI 開発用に自動生成した架空のデータです。実在の統計ではありません。

## 地図

[Natural Earth](https://www.naturalearthdata.com/)（[world-atlas](https://github.com/topojson/world-atlas) 経由、パブリックドメイン）。
