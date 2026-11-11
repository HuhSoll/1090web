# 研究用データの配布方法

公開サイト（GitHub Pages）に必要なのは、地図用の月別 JSON だけです。研究用の大きなファイル（Parquet）は Git に入れず、**GitHub Releases の添付ファイル**として配布します。Git には、ファイルごとのサイズと SHA-256 を書いた小さな一覧（マニフェスト）だけを置きます。

## 対象ファイル

| ファイル | 内容 | 作り方 |
| --- | --- | --- |
| `public/data/<id>/research/routes_monthly.parquet` | 月 × 路線 × 航空会社 × 分類 × 空港判定ルール × 信頼度の便数 | `pipeline/build_dataset.py` |
| `data/research/<id>/phase7/*.parquet` | 外部統計との路線単位の比較 | `pipeline/validation/report.py` |

CSV・JSON の集計結果やメタデータは小さいので、そのまま Git に入れています。

## 版との対応

- データセットの版（`manifest.json` の `datasetVersion`）ごとに、リリースのタグを1つ作ります：`research-<id>-v<版>`（例：`research-observed-2026-v2-v2.0.0`）。
- マニフェスト：`pipeline/releases/<id>.json`。各ファイルのパス、添付ファイル名、サイズ、SHA-256、ダウンロード URL を記録します。
- 添付ファイル名は、フォルダを `__` でつないだ平らな名前です（例：`observed-2026-v2__research__routes_monthly.parquet`）。

## 手順

```bash
# 1. マニフェストを作る（または更新する）。アップロード用のコマンドも表示されます
.venv/Scripts/python pipeline/release.py manifest --dataset observed-2026-v2

# 2. 手元のファイルがマニフェストと一致するか確認
.venv/Scripts/python pipeline/release.py verify --dataset observed-2026-v2

# 3. （利用者側）リリースから取得して検証
.venv/Scripts/python pipeline/release.py fetch --dataset observed-2026-v2
```

リリースの作成とアップロードは `gh release create` / `gh release upload` で行います（`manifest` が表示するコマンド）。**リポジトリの管理者が承認してから実行します。** 既存のファイルは削除しません。

## 作り直す場合

元データ（`pipeline/inputs.lock.json` と `pipeline/validation/external_inputs.lock.json` に記録したファイル）があれば、同じ手順で作り直せます。

```bash
.venv/Scripts/python pipeline/build_dataset.py --dataset observed-2026-v2 --version 2.0.0
.venv/Scripts/python pipeline/analysis/reliability.py --dataset observed-2026-v2 --compare-dataset observed-2026 \
    --raw-flights "data/raw/flights/*.parquet" --fetch-eurostat
.venv/Scripts/python pipeline/validation/report.py --dataset observed-2026-v2
```

`routes_monthly.parquet` は内容が同じでも、圧縮の都合でバイト列が変わることがあります（Phase 6A のテストでは、中身の行が同じことを確かめています）。その場合はマニフェストのハッシュとは一致しないので、`verify` は不一致を報告します。研究の再現には、リリースのファイルを使ってください。

## ライセンス

便データ由来の研究用ファイルは ODbL-1.0 です（[DATA_LICENSE.md](../DATA_LICENSE.md)）。外部統計（BTS・ANAC・国土交通省）由来の比較表には、それぞれの出典を明記しています（[phase7-report.md](phase7-report.md)）。
