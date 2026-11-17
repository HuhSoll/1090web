# 過去のイベント：データの出典（Phase 9G）

研究モードの「過去のイベント」と `pipeline/events/` が使うデータです。取得したファイルは `pipeline/events/sources.lock.json` に URL・取得時刻（保存版は保存時刻）・サイズ・SHA-256 とともに記録しています。元のファイル（`data/raw/events/`）は Git にも GitHub Pages にも入れていません。

## 一覧

| データ | 出典・URL | 取得 | ライセンス・利用条件 | 使い方 |
| --- | --- | --- | --- | --- |
| CZIB の現行の版 | EASA, Conflict Zone Information Bulletins `https://www.easa.europa.eu/en/domains/air-operations/czibs`（勧告ごとのページ `/en/node/<id>`） | 2026-11-17 | © EASA。出典を明記すれば複製可 | 各勧告の最新版の内容 |
| CZIB の一覧（エクスポート） | 同ページの JSON エクスポート `…/czibs/export-json?page&_format=json` | 2026-11-17 と保存版 4 回分（2025-07-20、2026-03-06、2026-04-14、2026-06-10） | 同上 | 各時点の状態・有効期限・更新時刻の確認 |
| CZIB の過去の版 | Internet Archive Wayback Machine の EASA のページの保存版（`http://web.archive.org/cdx/search/cdx` で検索、`/web/<時刻>id_/<URL>` で取得） | 2026-11-17 | 内容は © EASA（上と同じ）。保存版の時刻を記録 | 過去の版の内容と、初めて確認した時刻 |
| 観測便 | 1090web の ADS-B 由来の便データ（`public/data/observed-2026-v2/temporal/` の日別ファイル） | — | ODbL 1.0 | 前後の比較 |
| 収集停止 | Phase 6B・9A の判定（`temporal/index.json` の `collection_gap`） | — | 1090web の計算 | 警告と除外 |
| 外部統計（照合のみ） | EUROCONTROL, *Aviation Trends* 第 11 号「Impact of the current Middle East crisis on European aviation」（2026-03-31）`https://www.eurocontrol.int/publication/impact-current-middle-east-crisis-european-aviation` | 2026-11-18 閲覧 | 本文の数値を引用 | 傾向の定性的な照合（定義が違うため一致率は計算しない） |

## 取得できた範囲

| 勧告 | 確認できた版 | 取得できなかった版 |
| --- | --- | --- |
| 2025-01 ロシア | R0〜R3 | — |
| 2026-01 ベネズエラと周辺 | R0〜R2 | — |
| 2026-02 イランと周辺 | R0〜R1 | — |
| 2026-03 中東・ペルシャ湾 | R0〜R10、R12〜R14 | R11 |
| 2026-04 イラン | R0、R2、R3 | R1 |
| 2026-05 イラク | R3 | R0〜R2 |
| 2026-06 レバノン | R2、R3 | R0、R1 |
| 2026-07 ペルシャ湾・オマーン湾 | R0〜R4 | — |
| 2026-08 ヨルダン | R3、R4 | R0〜R2 |
| 2026-09 サウジアラビア | R0〜R2 | — |

39 版、174 の保存版・取得。記録の版（`recordsVersion`）は `b5874b27b0a8` です。

## 注意

- EASA は各勧告の最新版だけを公開し、過去の版の URL は最新版に転送されます。過去の版は第三者（Internet Archive）の保存版に頼っています。保存版がない版は内容を確認できず、補完していません。
- 保存版の一部は gzip で圧縮されたまま保存されており、読み込み時に展開しています（ファイルとチェックサムは元のまま）。
- 古いページには対象国の欄がなく、空域の説明に書かれた国を使います（記録に根拠を残す）。
- 日付は EASA の現地の日付で時刻がありません。保存版の時刻は公表時刻ではなく、その時点で公開されていたことを示すだけです。
- EASA の勧告は安全情報で、空域閉鎖・空港閉鎖・飛行禁止ではありません。各国の空域閉鎖（NOTAM など）は今回取得していません。
- 公開しているのは加工した記録（`public/data/events/easa-czib-history.json`、211 KB）だけです。勧告の文は要約（最大 600 字）にとどめ、出典を表示しています。
