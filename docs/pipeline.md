# データパイプライン

ADS-B 観測の便データ（四半期ごとの Parquet）を、地図用の月別データ（`public/data/observed-2026/`）に変換します。

## 実行方法

```bash
# 1. Python 環境（初回のみ）
python -m venv .venv
.venv/Scripts/python -m pip install -r pipeline/requirements.txt   # macOS/Linux は .venv/bin/python

# 2. 元データを data/raw/ に置く（Git 管理外）
#    data/raw/flights/2026_Q1_detailed_github.parquet など（MrAirspace の Releases から）
#    data/raw/ourairports/airports.csv（https://davidmegginson.github.io/ourairports-data/airports.csv）

# 3. 機材の旅客／貨物分類表を作り直す（元データが増えたとき）
.venv/Scripts/python pipeline/classify_aircraft.py data/raw/flights/2026_Q*_detailed_github.parquet

# 4. 公開データを生成（数分かかります）
.venv/Scripts/python pipeline/build_dataset.py --year 2026 --dataset observed-2026
```

出力：

| ファイル | 内容 |
| --- | --- |
| `public/data/observed-2026/manifest.json` | 月の一覧、航空会社コード（便数の多い順）、出典、品質サマリー |
| `public/data/observed-2026/airports.json` | 路線に登場する空港 |
| `public/data/observed-2026/routes.json` | 空港ペア（全月共通の路線 ID） |
| `public/data/observed-2026/months/YYYY-MM.json` | `[路線ID, 方向, 航空会社, 旅客, 貨物, 不明, 根拠]` の月別集計 |
| `data/quality/observed-2026.json` | 詳細な品質レポート |

## 変換ルール

1. **対象**：航空会社コードがある便だけ。ない便（自家用機など）は品質レポートで件数だけ数えます。
2. **四半期の重複**：ファイルの対象月に入る便だけを使います（出発時刻、なければ到着時刻で判定）。
3. **空港の判定**（出発・到着それぞれ）
   - 航跡の端が地上か 3,000ft 以下で、近くの空港が1つ → **観測**
   - 同じ条件で候補が複数 → 端点に最も近い空港。2位との差が 1km 未満なら決めない → **観測**
   - 便名の路線の空港が、航跡の端の候補に含まれる → **観測**
   - 航跡では決まらず、便名の路線だけがある → **便名から推定**
   - どれでもない → **判定不能**（地図から除外）
   - 候補のうち OurAirports にない空港・閉鎖空港・ヘリポートは使いません
4. **便ごとの根拠**：出発・到着の弱いほう。どちらかが判定不能なら除外。出発と到着が同じ空港の便も除外。
5. **旅客／貨物**：`pipeline/reference/aircraft_variant_class.csv` に従います。
   - 機材の型番が貨物機を示すときだけ貨物（777F、BCF/BDSF/SF/PCF などの改造機、A330-200F など）
   - 貨物型が存在しない旅客機（`pipeline/reference/passenger_only_types.csv`）は、型番の詳細がなくても旅客
   - それ以外で型番の詳細がない便は不明

分類表はスクリプトが自動生成しますが、すべての行に判定ルールを記録しています。見直す場合は CSV を確認してください。

## 2026年 Q1〜Q3 の結果

| 項目 | 便数 |
| --- | --- |
| 航空会社コード付き（重複除去後） | 26,862,421 |
| 空港を観測で確認 | 17,514,377（65.2%） |
| 便名の路線から推定 | 6,623,212（24.7%） |
| 判定不能（除外） | 2,724,832（10.1%） |
| 観測した空港と便名の路線が不一致（出発・到着の延べ） | 3,150,702 |
| 路線数／空港数／航空会社コード数 | 154,010 ／ 4,653 ／ 5,586 |

- 2026年5月は 31日中 30日分しかデータがありません（元データ側の欠け）。UI のタイムラインに表示しています。
- サウジアラビア国内やベトナム国内の幹線など、受信網が手薄な地域では、便がほぼすべて「便名から推定」になります。

## ライセンス上の注意

- 便データは **ODbL-1.0**。公開している集計データは派生データベースにあたるため、同じ ODbL-1.0 で提供し、出典を明記しています（アプリの「データと出典」）。
- OurAirports の利用条件は、サイトの証明書エラーのため原文を未確認です。
