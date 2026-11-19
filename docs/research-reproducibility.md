# 研究結果の再現（Phase 9I）

研究結果を後から同じ条件で計算し直すために、何を記録しているか、どう再実行するかをまとめます。

## 記録しているもの

| 項目 | イベント研究の JSON | 実験の結果 | 離島の結果 | 研究成果 |
| --- | --- | --- | --- | --- |
| データセットの ID・版 | `dataset` | `dataset`（大陸の規則を含む） | `buildVersion`・入力の一覧（`meta.json`） | `dataset` |
| 入力ファイルの識別 | 勧告・イベント記録の版（`recordsVersion`、出典の SHA-256） | 定義のハッシュ | 入力ファイルの SHA-256（`meta.json` の `inputs`） | 出典 |
| 期間 | `windows`（UTC の日、終わりは含まない） | `baseline.start / end` | — | `period` |
| 絞り込み・条件 | `conditions` | `definition`（ティア・閾値・向き・機材・地域） | シナリオ | `conditions` |
| 計算方法 | `methodVersion`（9i.1）、`method` の説明 | `methodVersion`（9e.2） | 9f.1 | `calculationVersion` |
| 指標の定義 | `method` | `computation.note`、[experiment-methodology.md](experiment-methodology.md) | [island-dependency-methodology.md](island-dependency-methodology.md) | `method` |
| 乱数シード | —（乱数なし） | `randomSeed`・`sourceSeed` | —（乱数なし） | — |
| 近似の設定 | — | `computation.sources`（厳密は全空港） | — | `conditions` |
| 対象空港の集合 | 対象地域の国、FIR | 候補（数と規則） | 停止空港 | `conditions` |
| 実装の版 | `environment.app`（アプリの版とコミット） | `environment`（ブラウザ：アプリの版とコミット／Python：Python・numpy の版と OS） | — | — |
| 外部データの出典 | イベント記録の出典 | — | `serviceSources` | `sourceReferences` |
| 警告 | `warnings` | `warnings`（読み込み時） | — | `limitations` |

- 研究モードの「はじめに」には、表示中のデータセットの版、計算方法の版、アプリの版とコミットを表示します。
- アプリの版とコミットはビルド時に埋め込みます（`vite.config.ts` の `__APP_BUILD__`）。

公開用のファイルには、機体の登録記号・ICAO アドレス・便名そのものと、再配布が許可されていない外部データ（EAD の NOTAM、ダウンロードした出典の本文）を入れていません。

## 再実行の方法

### 独立の検証（Phase 9I）

研究用データ（`data/research/observed-2026-v2/temporal/`、[research-data-release.md](research-data-release.md)）と元の ADS-B ファイル（`data/raw/flights/`）が必要です。

```bash
.venv/Scripts/python pipeline/research_validation/temporal_counts.py
```

```bash
.venv/Scripts/python pipeline/research_validation/event_series.py
```

```bash
.venv/Scripts/python pipeline/research_validation/network_impact.py PER ANC BOG HND ORD LIM ISG MMY
```

```bash
.venv/Scripts/python pipeline/research_validation/experiment_ties.py
```

```bash
.venv/Scripts/python pipeline/research_validation/island_access.py
```

結果は `data/quality/validation-9i-*.json` に書き出されます。イベント研究の検証の系列は `tests/events/validation.test.ts` の固定値（`validation.fixture.json`）になっており、ブラウザの計算と照合されます。

### 実験（Phase 9E）

```bash
.venv/Scripts/python pipeline/experiments/run.py pipeline/experiments/configs/march-sensitivity-exact.json
```

- 設定ファイルは `pipeline/experiments/configs/` にあります。
- 近似の比較（conv-256-2、conv-256-3、conv-1024-1）の定義も、9I で設定ファイルに戻しました。保存されたハッシュと一致します。
- 結果の `methodVersion` が 9e.1 のファイルは、順位相関が同順位を正しく扱っていません。読み込むと警告が出ます。

### イベント研究（Phase 9G・9H）

研究モード → イベント調査 → イベントを選択 → 前後のネットワークを比較 → 研究（JSON）で保存します。JSON の `conditions` と `event` の版で、同じ比較をやり直せます。

## 訂正の記録

過去の報告で誤りが見つかったときは、元の記述を消さず、報告の末尾に「Phase 9I による訂正」として、何をどう直したかを追記しています。

- [phase9e-report.md](phase9e-report.md)：順位相関の同順位（全空港の Spearman、近似と厳密の比較）
- [phase9g-report.md](phase9g-report.md)：事前トレンドの t の計算方法、DiD の扱い、プラセボの計算方法
- [phase9h-report.md](phase9h-report.md)：DiD の 3 か国の値、時間関係の記述

研究成果では、誤りと分かった主張を「支持されない」として残しています（F-9H-DID、F-9H-TIMING）。

## キャッシュ

データや計算方法が違う結果を、取り違えて再利用しないようにしています。

| 対象 | 保持のしかた |
| --- | --- |
| イベント研究 | イベントの ID と条件の全体をキーにして、メモリにキャッシュ。仮想停止の計算も同じキーを含む |
| 実験 | 最後の結果を 1 つだけ保持し、定義のハッシュ・データセットの版・計算方法の版を結果に記録。読み込んだ結果の版が違えば警告 |

保持した結果はブラウザのメモリの中だけにあり、ページを読み込み直すと消えます。
