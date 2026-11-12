# データパイプライン

ADS-B 観測の便データ（四半期ごとの Parquet）を、地図用の月別データと研究用の集計表に変換します。
現在の既定データは `public/data/observed-2026-v2/`（バージョン 2.0.0、Phase 6A）です。旧版 `observed-2026/` は比較用に残しており、`?dataset=observed-2026` で表示できます。

## 実行方法

```bash
# 1. Python 環境（初回のみ）
python -m venv .venv
.venv/Scripts/python -m pip install -r pipeline/requirements.txt   # macOS/Linux は .venv/bin/python

# 2. 元データを data/raw/ に置く（Git 管理外）
#    data/raw/flights/2026_Q1_detailed_github.parquet など（MrAirspace の Releases から）
#    data/raw/ourairports/airports.csv（https://davidmegginson.github.io/ourairports-data/airports.csv）
#    pipeline/inputs.lock.json に記録した SHA-256 と一致しないと生成は止まります

# 3. テスト（合成データだけを使い、実データは読みません）
cd pipeline && ../.venv/Scripts/python -m pytest -q && cd ..

# 4. 機材の旅客／貨物分類表を作り直す（元データが増えたとき）
.venv/Scripts/python pipeline/classify_aircraft.py data/raw/flights/2026_Q*_detailed_github.parquet

# 5. 公開データを生成（全9か月で約30分）。出力先が空でないと上書きせずに止まります
.venv/Scripts/python pipeline/build_dataset.py --dataset observed-2026-v2 --version 2.0.0
#    動作確認だけなら --months 2026-01 で1か月分

# 6. 旧版との比較
.venv/Scripts/python pipeline/compare_datasets.py public/data/observed-2026 public/data/observed-2026-v2     --out docs/audit-data/phase6a-v1-v2-comparison.json
```

研究用の信頼性評価（Phase 6B）：観測の欠け、地域別の品質、月次正規化、T1〜T4・低頻度路線・ランキングの感度、Eurostat との比較を `data/research/<id>/phase6b/` に出力します（公開サイトには含めません）。詳しくは [phase6b-report.md](phase6b-report.md)。

```bash
.venv/Scripts/python pipeline/analysis/reliability.py --dataset observed-2026-v2     --compare-dataset observed-2026 --raw-flights "data/raw/flights/*.parquet" --fetch-eurostat
```

公的統計との照合（Phase 7）：米国 BTS T-100、ブラジル ANAC、日本の国土交通省の統計を取得し、路線・空港・全国合計の単位で比べます。取得したファイルは `data/raw/external/`（Git 管理外）に置き、SHA-256・取得日時・URL を `pipeline/validation/external_inputs.lock.json` に記録します。詳しくは [phase7-report.md](phase7-report.md)。

```bash
.venv/Scripts/python pipeline/validation/bts.py fetch --year 2026 --months 1-7      # 公式フォームから月ごとに取得
.venv/Scripts/python pipeline/validation/bts.py import <手動で取得した zip> --year 2026 --month 8
.venv/Scripts/python pipeline/validation/anac.py fetch-vra --year 2026 --months 1-9
.venv/Scripts/python pipeline/validation/anac.py fetch-stats
.venv/Scripts/python pipeline/validation/japan.py --year 2026 --months 1-8
.venv/Scripts/python pipeline/validation/report.py --dataset observed-2026-v2      # data/research/<id>/phase7/
```

研究モード（ブラウザ）用の軽量なファイル（根拠区分 T2・T3 の内訳、路線の観測月数、品質・外部照合の要約）は、研究用の集計から作ります。`public/data/<id>/research-web/` に出力され、サイトで配信されます（約 12 MB）。

```bash
.venv/Scripts/python pipeline/research_web.py --dataset observed-2026-v2
```

時間軸データ（Phase 9A）：月次データと同じ空港判定・分類で、便ごとの時刻（航跡の開始・終了、基準時刻）を保持します。研究用は月ごとの Parquet（`data/research/<id>/temporal/`、非公開）、公開用は UTC の日ごとのファイル（`public/data/<id>/temporal/`、約 220 MB、gzip で約 65 MB）です。日ごとの合計は月次データと路線・方向・航空会社・分類・根拠のすべての組で一致することを確認します。形式は [temporal-data-model.md](temporal-data-model.md)。

```bash
.venv/Scripts/python pipeline/temporal.py --months 2026-03 --days 2026-03-01,2026-03-10   # 一部だけ
.venv/Scripts/python pipeline/temporal.py                                                 # 全期間（約 25 分）
.venv/Scripts/python pipeline/temporal_verify.py                                          # 月次データとの照合
```

研究用の Parquet は Git に入れず、GitHub Releases で配布します（[research-data-release.md](research-data-release.md)）。

元データを新しい版に差し替えるときは、`inputs.lock.json` を更新し、新しいデータセット ID とバージョンで生成してください。既存のデータセットは上書きしません。

出力（`<id>` はデータセット ID）：

| ファイル | 内容 |
| --- | --- |
| `public/data/<id>/manifest.json` | 月の一覧、航空会社コード（便数の多い順）、出典、品質サマリー、データセットのバージョン |
| `public/data/<id>/airports.json` | 路線に登場する空港 |
| `public/data/<id>/routes.json` | 空港ペア（全月共通の路線 ID） |
| `public/data/<id>/months/YYYY-MM.json` | `[路線ID, 方向, 航空会社, 旅客, 貨物, 不明, 根拠]` の月別集計 |
| `public/data/<id>/provenance.json` | 入力ファイルと SHA-256、OurAirports の取得日、ルールのバージョン、Git コミット、Python／DuckDB のバージョン |
| `public/data/<id>/research/routes_monthly.parquet` | 月 × 出発 × 到着 × 航空会社 × 分類 × 端ごとのルール（R1〜R5）× 信頼度（T1〜T4／X）の便数 |
| `public/data/<id>/research/airports.csv` | 空港と OurAirports のレコード ID |
| `public/data/<id>/research/airport_aliases.csv` | 統合した空港コードと、決めきれなかったコード |
| `public/data/<id>/research/coverage_daily.csv` | 日別・地域別の便数と「少なすぎる疑い」の検出結果 |
| `data/quality/<id>.json` | 詳細な品質レポート |

## 変換ルール

1. **対象**：航空会社コードがある便だけ。ない便（自家用機など）は品質レポートで件数だけ数えます。
2. **四半期の重複**：ファイルの対象月に入る便だけを使います（出発時刻、なければ到着時刻で判定）。
3. **空港コードの統一**：OurAirports の同じレコードを指すコード（旧 ident、GPS コードなど）だけを1つの空港にまとめます。IATA コードが同じというだけでは統合しません。1つのコードが複数のレコードに当てはまる場合は優先順位（ICAO > ident > GPS、空港の規模）で1つを使い、`airport_aliases.csv` に「未解決」として残します。空港名の表示を例外的に変える場合は `pipeline/reference/airport_canonical_overrides.csv` に理由付きで記録します（現在は KPBI のみ）。
4. **空港の判定**（出発・到着それぞれ、R1〜R5）
   - **R1**：航跡の端が地上か 3,000ft 以下で、近くの空港候補が1つ
   - **R2**：同じ条件で候補が複数 → 端点に最も近い空港。2位との差が 1km 未満なら決めない
   - **R3**：便名の路線の空港が、航跡の端の候補に含まれる（航跡の端が上空でも可）
   - **R4**：航跡では決まらず、便名の路線だけがある
   - **R5**：どれでもない → 判定不能
   - 航跡が空港を指しているのに便名の路線の空港が候補にない端は「不一致」として記録します（R1/R2 なら航跡の結果を採用）。
   - 候補のうち OurAirports にない空港・閉鎖空港・ヘリポートは使いません
5. **便ごとの信頼度**（両端のルールから決めます）：T1＝両端とも R1/R2 で不一致なし、T2＝両端とも R1/R2 だが便名の路線と不一致の端がある、T3＝R3 の端があり R4/R5 はない、T4＝R4 の端がある、X＝R5 の端がある（地図から除外）。地図の「根拠」は従来どおり T1〜T3 が「観測」、T4 が「便名から推定」です。出発と到着が同じ空港の便も除外します。
   - T4 の誤り率は測れません。便名の路線と航跡が両方ある便での不一致率は、航跡がない便の誤り率とは別物です。
6. **旅客／貨物**：`pipeline/reference/aircraft_variant_class.csv` に従います。
   - 機材の型番が貨物機を示すときだけ貨物（777F、BCF/BDSF/SF/PCF などの改造機、A330-200F など）
   - 貨物型が存在しない旅客機（A320neo ファミリー、737 MAX など。`pipeline/reference/passenger_only_types.csv`）は、型番の詳細がなくても旅客
   - 型式と型番の詳細が矛盾する便、型番の詳細がない便は不明
   - これは機材の分類で、その便が実際に旅客を運んだかどうかではありません

分類表はスクリプトが自動生成しますが、すべての行に判定ルールを記録しています。見直す場合は CSV を確認してください。

7. **観測範囲の検出**：日別・地域別の便数を、同じ曜日の前後28日の中央値と比べ、0.8 未満の日に印を付けます。検出だけで、補正や補完はしません（Phase 6B）。印の付いた日が実際に欠けているとは限りません。

## 2026年 Q1〜Q3 の結果（v2）

| 項目 | 便数 |
| --- | --- |
| 航空会社コード付き（重複除去後） | 26,862,421 |
| 空港を観測で確認（T1〜T3） | 17,521,798（65.2%） |
| 便名の路線から推定（T4） | 6,615,791（24.6%） |
| 判定不能（X、除外） | 2,724,832（10.1%） |
| 観測した空港と便名の路線が不一致の便 | 1,889,200 |
| 出発と到着が同じ空港になった便（除外） | 1,228,974 |
| 地図に載る便（旅客／貨物／不明） | 22,908,615（19,609,499 ／ 602,097 ／ 2,697,019） |
| 路線数／空港数／航空会社コード数 | 153,930 ／ 4,644 ／ 5,585 |

v1 との違いと、その理由は [phase6a-report.md](phase6a-report.md) にあります。

- 2026年5月は 31日中 30日分しかデータがありません（元データ側の欠け）。UI のタイムラインに表示しています。
- サウジアラビア国内やベトナム国内の幹線など、受信網が手薄な地域では、便がほぼすべて「便名から推定」になります。

## ライセンス上の注意

- 便データは **ODbL-1.0**。公開している集計データは派生データベースにあたるため、同じ ODbL-1.0 で提供し、出典を明記しています（アプリの「データと出典」）。
- OurAirports の利用条件は、サイトの証明書エラーのため原文を未確認です。

## 安全情報（EASA の紛争地域情報）

```bash
.venv/Scripts/python pipeline/build_advisories.py --fetch   # EASA から最新を取得して public/data/advisories/ を更新
```

- 出典：[EASA Conflict Zone Information Bulletins](https://www.easa.europa.eu/en/domains/air-operations/czibs)（JSON エクスポート）。EASA の著作権表示により、出典を明記すれば再利用できます。
- 種類は「安全警告」です。空域閉鎖・気象警報・欠航とは区別し、路線データには一切影響させません。
- 各情報の有効期間は「発行日〜有効期限」。取り下げ済みのものは取り下げ日が公開されていないため、最終更新日を終了日とし「推定」と表示します。
- 地図は国単位でしか塗れないため、一部の空域（FIR・州）や広域が対象のものは「国全体で表示」と明記しています。バーレーンなど小さな国は地図データにないため、一覧には出ますが塗られません。
- 空域制限（FAA など）は HTML のみの提供、気象警報（aviationweather.gov）は過去30日分しか取得できず観測期間と合わないため、現時点では扱っていません。

