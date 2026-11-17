# イベント調査：データの出典（Phase 9H）

イベントの記録（`public/data/events/events.json`）が使っている出典の一覧です。ダウンロードした文書は `data/raw/events/sources/` に置き、リポジトリには入れていません（著作権・利用条件のため）。公開しているのは次の 3 つだけです。

- URL
- 取得時刻と SHA-256
- 出典から書き起こした事実（日付、範囲、対象）

EASA CZIB の出典は [historical-event-sources.md](historical-event-sources.md) にあります（Phase 9G）。

## 一覧

| ID | 発行元 | 種類 | 内容 | 取得 |
| --- | --- | --- | --- | --- |
| `easa-czib-2026-03-current` | EASA | 当局 | CZIB 2026-03 の現行のページ（攻撃・停戦の日付の記述） | 取得 |
| `faa-us-restrictions-live` | FAA | 当局 | U.S. Restrictions on Foreign Airspace（現行） | 取得 |
| `faa-us-restrictions-20260212`、`-20260301`、`-20260313`、`-20260407` | FAA（Internet Archive） | 保存版 | 同じページの危機の前後の保存版 | 取得 |
| `faa-sfar-117` | FAA | 当局 | SFAR 117：テヘラン FIR（米国の運航者） | 取得 |
| `faa-sfar-77` | FAA | 当局 | SFAR 77：バグダッド FIR の FL320 未満（米国の運航者） | 取得 |
| `faa-kicz-a0016-20` | FAA | 当局 | KICZ A0016/20：ペルシャ湾・オマーン湾の上空 | 取得 |
| `faa-kicz-a0056-26` | FAA | 当局 | KICZ A0056/26 | 取得 |
| `gcaa-safety-decision-2026-03` | UAE GCAA | 当局 | Safety Decision 2026-03：無人機・軽スポーツ機の運航停止 | 取得 |
| `qna-uae-partial-closure` | QNA（カタール国営通信） | 国営通信 | UAE の空域の一時的・部分的閉鎖 | 取得 |
| `khaleej-uae-partial` | Khaleej Times | 報道 | 同上（公開 09:42 UTC） | 取得 |
| `peninsula-qatar-suspension` | The Peninsula | 報道 | カタールの航空交通の一時停止（公開 09:21 UTC） | 取得 |
| `peninsula-hia-suspension` | The Peninsula | 報道 | ハマド国際空港の運航停止（公開 10:13 UTC） | 取得 |
| `iol-qatar-continues` | IOL | 報道 | 3 月 7 日時点で閉鎖が続き、特別便のみ | 取得 |
| `egypttoday-kuwait-closed` | Egypt Today | 報道 | クウェートの空域・空港の閉鎖 | 取得 |
| `peninsula-kuwait-reopen` | The Peninsula | 報道 | クウェートの再開（2026-04-23） | 取得 |
| `israelhayom-closure` | Israel Hayom | 報道 | イスラエルの空域閉鎖 | 取得できず（HTTP 403） |
| `eurocontrol-trends-11` | EUROCONTROL | 当局 | Aviation Trends | 取得できず（HTTP 403） |
| `eurocontrol-ead` | EUROCONTROL | 当局 | European AIS Database（NOTAM） | 取得できず（HTTP 403。登録制） |

取得の記録（状態、HTTP ステータス、取得時刻、SHA-256）は `pipeline/events/sources-documents.lock.json` にあります。

## 取得できなかったもの

`events.json` の `notCaptured` に記録しています。

- イスラエルの閉鎖と段階的な再開：記事が取得できず（HTTP 403）、イスラエル空港公団の発表も得られませんでした。
- バーレーンの閉鎖と再開：公式の文書・報道とも得られませんでした（見つかった記事はクウェートについてのものでした）。
- イラン、イラク、ヨルダン、サウジアラビア、オマーンの国内措置：今回は探していません。
- 各国の NOTAM（EUROCONTROL EAD）：登録が必要で、過去の NOTAM は再配布できません。
- 危機中に出された FAA の通知：2026-02-12〜04-07 の制限一覧の保存版には同じ 3 文書しかありません。一覧に載らない NOTAM は確認していません。

## 注意

- 報道の公開時刻は、発表の時刻の上限として記録しています。発表そのものの時刻ではありません。
- 保存版の時刻は、その時点で文書がすでにあったことを示すだけです。
- 出典の利用条件はそれぞれの発行元に従います。有料・登録制のデータは使っていません。再配布もしていません。
