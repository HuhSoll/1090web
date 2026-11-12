# 時間軸データモデル（Phase 9A）

ADS-B 由来の観測便を、日付・時刻の単位でネットワークに再構成するためのデータ仕様です。Phase 9B（UI）と将来のシミュレーションは、この仕様を使います。

実装：`pipeline/temporal.py`（生成）、`pipeline/temporal_verify.py`（月次との照合）、`src/temporal/`（ブラウザ側の読み込みと時間窓）。

---

## 1. 時刻の定義（UTC）

| 名前 | 定義 | 注意 |
| --- | --- | --- |
| `trackStartTime` | ADS-B の航跡の最初の点の時刻（`Track_Origin_DateTime_UTC`） | 離陸時刻とは限りません |
| `trackEndTime` | 航跡の最後の点の時刻（`Track_Destination_DateTime_UTC`） | 着陸時刻とは限りません |
| `referenceTime` | `trackStartTime`、なければ `trackEndTime` | 月次データ（v1・v2）と同じ定義 |
| `timeBasis` | `TRACK_START` または `TRACK_END_FALLBACK` | `referenceTime` がどちらの時刻か |

- 元データの時刻はタイムゾーンの表記がない UTC の文字列（`YYYY-MM-DD HH:MM:SS`、欠損は `-`）です。2026年 1〜9月の全行で、タイムゾーンの表記（`T`・`Z`・`+`）は0件、解析できない時刻も0件でした。
- 時刻を補って作ることはしません。出発側の時刻がない便は `TRACK_END_FALLBACK` のまま扱い、出発時刻を推定しません。
- 「予定出発時刻」「実際の離陸時刻」として扱ってはいけません。

## 2. 時間窓

- 時間窓は半開区間 **[start, end)** です。`start <= referenceTime < end` の便を数えます（基準時刻による所属）。
- 「時間窓の間に飛んでいた可能性のある便」（航跡の開始〜終了が窓と重なる便）は別の選び方で、今回は実装していません。混ぜて使いません。将来は研究用データの `trackStartTimeUtc`・`trackEndTimeUtc` を使って追加できます。
- 公開用データの時刻は分単位です。境界が分ちょうどの窓（1時間、6時間、日、任意の HH:MM）は、秒まで使った場合と同じ便を選びます。
- 日付別ファイルは「基準時刻がその UTC 日付に入る便」を入れます。日をまたぐ窓は、該当する日のファイルをすべて読みます。

## 3. 研究用データ（非公開）

`data/research/<dataset>/temporal/flights_<YYYY-MM>.parquet`（Git には入れません。GitHub Releases で配布できます：[research-data-release.md](research-data-release.md)）

| 列 | 内容 |
| --- | --- |
| `flightId` | 元データの行の内容から作った識別子（同じ入力からは同じ値。月ごとに処理しても同じ） |
| `originAirport` / `destinationAirport` | 月次データと同じ空港判定（R1〜R5）の結果。判定不能は NULL |
| `trackStartTimeUtc` / `trackEndTimeUtc` / `referenceTimeUtc` | 上の定義どおり（秒単位） |
| `timeBasis` | `TRACK_START` / `TRACK_END_FALLBACK` |
| `airlineCode` / `aircraftClass` | 便名の頭の文字、機材の型式による分類 |
| `originRule` / `destinationRule` / `confidenceTier` / `callsignConflict` | 月次データと同じ R1〜R5、T1〜T4／X、不一致 |
| `onMap` / `sameAirport` | 地図とネットワークに載る便か（T1〜T4、両端あり、出発≠到着）、出発＝到着か |
| `sourceQuarter` | 元の四半期ファイル |

機体の登録記号、ICAO アドレス、便名そのものは入れていません。`flightId` は行の内容のハッシュで、研究用データの中だけで使います。

## 4. 公開用データ（ブラウザ）

`public/data/<dataset>/temporal/`

| ファイル | 内容 |
| --- | --- |
| `manifest.json` | 版、生成日時、日付の範囲、形式の説明、時刻の定義、出典とライセンス、各ファイルのサイズ・gzip サイズ・SHA-256、形式の比較結果 |
| `index.json` | 日ごとの便数、ファイル名、1時間ごとの便数（24個）、大陸別の便数、Phase 6B の異常・収集停止の判定 |
| `quality.json` | 時刻の品質（欠損・異常の件数）、観測の異常の判定に使った閾値、収集停止の区間、2026年5月5〜7日の表示用メタデータ |
| `days/YYYY-MM-DD.json` | その日の便（地図に載る便だけ） |

### 日別ファイルの形式（schemaVersion 1）

路線ごとにまとめた列形式です。

| 列 | 内容 |
| --- | --- |
| `n` | 便数 |
| `r` | 路線のまとまりごとの路線 ID（データセットの `routes.json`）。昇順で、前の値との差 |
| `k` | まとまりごとの便数 |
| `t` | 便ごとの基準時刻（00:00 UTC からの分）。まとまりの中で前の便との差（最初の便は絶対値） |
| `c` | 便ごとの航空会社コード（データセットの `manifest.json` の `carriers` の順番） |
| `x` | 便ごとに 方向 + 2×分類 + 6×(区分−1) + 24×時刻基準。方向 0 = `routes.json` の a → b、分類 0 旅客・1 貨物・2 不明、区分 1〜4 = T1〜T4、時刻基準 0 = TRACK_START・1 = TRACK_END_FALLBACK |

路線 ID・航空会社の並びは月次データと共通なので、空港情報・路線情報はそのまま使えます。

### 形式の選び方（実測、2026年3月）

| 形式 | 1日あたり（生） | 1日あたり（gzip） | 時間単位の再構成 |
| --- | --- | --- | --- |
| A 日別の路線集計 | 約 0.95 MB | 約 0.17 MB | できない |
| A2 1時間ごとの路線集計 | 約 1.7 MB | 約 0.34 MB | 1時間単位のみ |
| B 時刻順のイベント（秒、継続時間つき） | 約 1.36 MB | 約 0.48 MB | できる |
| B 時刻順のイベント（分） | 約 1.1 MB | 約 0.34 MB | できる |
| **B 路線ごとにまとめたイベント（分、公開形式）** | **約 0.79 MB** | **約 0.22 MB** | **できる** |

路線ごとにまとめたイベントは、日別の路線集計よりも生のサイズが小さく、日次・時間単位・任意の窓をすべて再構成できます。日別集計とイベントの両方を持つ方式（C）は容量が増えるだけなので採用しませんでした。

## 5. ブラウザ側の API（`src/temporal/`）

```ts
import { TemporalLoader } from './temporal/loader';
import { windowAsResearchMonth, routeCounts, hourlyCounts } from './temporal/model';

const loader = new TemporalLoader(import.meta.env.BASE_URL, 'observed-2026-v2'); // 日は最大 10 日分をメモリに保持
const index = await loader.loadIndex();                    // 日ごとの便数・異常・1時間ごとの便数
const sel = await loader.window(Date.UTC(2026, 2, 10, 12), Date.UTC(2026, 2, 10, 18)); // [12:00, 18:00) UTC
sel.flights;                                               // 便数
routeCounts(sel, true);                                    // 方向別: key = route*2 + direction
routeCounts(sel, false);                                   // 無向: key = route
hourlyCounts(sel);                                         // 窓の中の1時間ごとの便数
const month = windowAsResearchMonth(sel, carrierIds, '2026-03-10T12/18');
// → Research Mode の buildResearchNetwork・指標計算にそのまま渡せる（根拠区分・分類・航空会社・地域・閾値の絞り込みも同じ）
```

- `selectWindow`（純粋関数）は二分探索で選ぶだけで、データをコピーしません。
- 必要な日のファイルが存在しない場合は `missingDays` に入ります（値は作りません）。
- 1つの窓で読み込む日数の上限は 10 日です（それより長い期間は月次データを使います）。

## 6. 品質情報

- `index.json` の各日：便数、1時間ごとの便数、大陸別の便数、Phase 6B の判定（少ない／多い、範囲、根拠、全世界の比率、ギャップ時間）。
- `quality.json`：時刻の欠損・異常の件数（§7）、判定の閾値（基準値は同じ曜日の前後28日の中央値、少ない日は 0.8 未満、ギャップは 1時間の便数が基準値の 5% 以下）、ギャップの区間、閾値を変えた場合のギャップ、急増した時間。
- 2026年5月5日 00:00〜5月7日 18:00 UTC（66時間）は `knownGap` として記録しています。データ収集の停止と推定（提供元で確認したものではありません）で、航空交通の減少ではありません。
- 観測が少ないだけの日は、収集障害と断定していません。

## 7. 将来のシミュレーションへの拡張

時間軸（`src/temporal/`）とネットワーク（`src/research/`）は独立しています。将来のシミュレーションは、観測データを変えずに、その上に「仮想イベント」を重ねる形を想定しています。

```ts
// 想定するイベントの型（未実装）
type ScenarioEvent =
  | { kind: 'airportClosure'; airport: string; startMs: number; endMs: number | null }
  | { kind: 'airportReopen'; airport: string; atMs: number }
  | { kind: 'routeClosure'; route: number; startMs: number; endMs: number | null }
  | { kind: 'capacityReduction'; airport: string; startMs: number; endMs: number; factor: number };
```

- 観測の時刻（`referenceTime`）と仮想イベントの時刻（シナリオの時刻）は別の型・別の名前で持ち、混ぜません。
- 観測ネットワークは `windowAsResearchMonth` → `buildResearchNetwork` で作り、シナリオはその結果（辺の集合）に対して適用する、という段階に分けます。こうすると、同じ窓について「観測」と「シナリオ」を並べて比べられます。
- 空港の停止・再開、路線の停止、複数空港の同時停止、段階的な容量削減、イベントの拡大・復旧は、すべて「時間窓ごとに辺を除く／重みを減らす」操作として表せます。
