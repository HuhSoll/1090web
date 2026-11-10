/**
 * UI strings. `en` defines the key set; `ja` is typed against it, so a missing translation is a
 * compile error (and tests/i18n.test.ts additionally checks for empty strings).
 * Placeholders use {name} syntax.
 */
export const en = {
  'app.tagline': "Explore the world's aviation network.",
  'app.loading': 'Loading network…',
  'app.loadingMonth': 'Loading {month}…',
  'app.error.title': 'Could not load the network data',
  'app.error.retry': 'Retry',
  'app.webgl.title': 'WebGL 2 is not available',
  'app.webgl.body': 'AeroGraph needs a browser with WebGL 2 enabled to draw the globe.',
  'app.basemapError': 'The base map could not be loaded. Routes are still shown.',

  'demo.badge': 'DEMO DATA',
  'demo.banner': 'Synthetic demo dataset — routes, carriers and flight counts are not real statistics.',
  'stress.badge': 'STRESS TEST',
  'stress.banner': 'Renderer stress test with {count} random routes. Not real data.',

  'lang.label': 'Language',

  'search.label': 'Airport search',
  'search.placeholder': 'IATA / ICAO / city / name',
  'search.noResults': 'No airports found',
  'search.clear': 'Clear search',

  'filters.title': 'Filters',
  'filters.country': 'Country',
  'filters.countryAll': 'All countries',
  'filters.carrier': 'Airline',
  'filters.carrierAll': 'All airlines',
  'filters.traffic': 'Traffic',
  'filters.trafficAll': 'Passenger + cargo',
  'filters.trafficPassenger': 'Passenger only',
  'filters.trafficNote': 'Flights with unknown classification are excluded in passenger-only mode.',
  'filters.threshold': 'Min. monthly flights',
  'filters.thresholdValue': '≥ {value}',
  'filters.thresholdOff': 'Show all',
  'filters.reset': 'Reset filters',

  'roadmap.title': 'Coming in later phases',
  'roadmap.compare': 'Month-to-month comparison',
  'roadmap.incidents': 'Incident overlay (official sources)',
  'roadmap.observed': 'Observed 2026 ADS-B data',
  'roadmap.notAvailable': 'Not yet available',

  'summary.title': 'Network overview',
  'summary.routes': 'Visible routes',
  'summary.airports': 'Active airports',
  'summary.flights': 'Monthly flights',
  'summary.hint': 'Click an airport on the globe or search to inspect it.',

  'airport.title': 'Airport',
  'airport.close': 'Clear selection',
  'airport.flights': 'Monthly movements',
  'airport.routes': 'Connected routes',
  'airport.coords': 'Coordinates',
  'airport.routeList': 'Routes by monthly flights',
  'airport.noRoutes': 'No routes match the current filters.',
  'airport.hidden': 'This airport has no routes under the current filters.',

  'route.title': 'Route',
  'route.back': 'Back to airport',
  'route.distance': 'Great-circle distance',
  'route.flights': 'Monthly flights',
  'route.direction': 'By direction',
  'route.breakdown': 'By classification',
  'route.passenger': 'Passenger',
  'route.cargo': 'Cargo',
  'route.unknown': 'Unknown',
  'route.carriers': 'By airline',
  'route.hidden': 'This route is hidden by the current filters.',

  'unit.flights': '{value} flights',
  'unit.km': '{value} km',

  'timeline.label': 'Month',
  'timeline.play': 'Play months',
  'timeline.pause': 'Pause',
  'timeline.prev': 'Previous month',
  'timeline.next': 'Next month',
  'timeline.observedDays': '{days} observed days',
  'timeline.disabled': 'Single snapshot',

  'globe.autoRotate': 'Auto-rotate',
  'globe.zoomIn': 'Zoom in',
  'globe.zoomOut': 'Zoom out',
  'globe.reset': 'Reset view',

  'source.title': 'Data & sources',
  'source.dataset': 'Dataset',
  'source.period': 'Period',
  'source.generated': 'Generated',
  'source.license': 'License',
  'source.basemap': 'Base map: Natural Earth via world-atlas (public domain)',
  'source.close': 'Close',
  'source.open': 'Data & sources',

  'tooltip.clickToSelect': 'Click to select',
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

export const ja: Messages = {
  'app.tagline': '世界の航空ネットワークを探索する。',
  'app.loading': 'ネットワークを読み込み中…',
  'app.loadingMonth': '{month} を読み込み中…',
  'app.error.title': 'ネットワークデータを読み込めませんでした',
  'app.error.retry': '再試行',
  'app.webgl.title': 'WebGL 2 が利用できません',
  'app.webgl.body': '地球儀の描画には WebGL 2 に対応したブラウザが必要です。',
  'app.basemapError': '地図データを読み込めませんでした。路線は引き続き表示されます。',

  'demo.badge': 'デモデータ',
  'demo.banner': '合成デモデータです。路線・航空会社・便数は実際の統計ではありません。',
  'stress.badge': '負荷テスト',
  'stress.banner': 'ランダムな {count} 路線による描画負荷テストです。実データではありません。',

  'lang.label': '言語',

  'search.label': '空港検索',
  'search.placeholder': 'IATA / ICAO / 都市 / 空港名',
  'search.noResults': '該当する空港がありません',
  'search.clear': '検索をクリア',

  'filters.title': 'フィルター',
  'filters.country': '国・地域',
  'filters.countryAll': 'すべての国・地域',
  'filters.carrier': '航空会社',
  'filters.carrierAll': 'すべての航空会社',
  'filters.traffic': '便の種類',
  'filters.trafficAll': '旅客＋貨物',
  'filters.trafficPassenger': '旅客のみ',
  'filters.trafficNote': '旅客のみ表示では、分類不明の便は集計から除外されます。',
  'filters.threshold': '月間便数の下限',
  'filters.thresholdValue': '{value} 便以上',
  'filters.thresholdOff': 'すべて表示',
  'filters.reset': 'フィルターをリセット',

  'roadmap.title': '今後のフェーズで提供',
  'roadmap.compare': '月次ネットワークの比較',
  'roadmap.incidents': 'インシデント情報（公式情報）',
  'roadmap.observed': '2026年 ADS-B 観測データ',
  'roadmap.notAvailable': '未実装',

  'summary.title': 'ネットワーク概要',
  'summary.routes': '表示中の路線',
  'summary.airports': '稼働空港',
  'summary.flights': '月間便数',
  'summary.hint': '地球儀上の空港をクリックするか、検索して詳細を表示します。',

  'airport.title': '空港',
  'airport.close': '選択を解除',
  'airport.flights': '月間発着便数',
  'airport.routes': '接続路線',
  'airport.coords': '座標',
  'airport.routeList': '月間便数順の路線',
  'airport.noRoutes': '現在のフィルターに一致する路線はありません。',
  'airport.hidden': '現在のフィルターではこの空港の路線は表示されません。',

  'route.title': '路線',
  'route.back': '空港に戻る',
  'route.distance': '大圏距離',
  'route.flights': '月間便数',
  'route.direction': '方向別',
  'route.breakdown': '分類別',
  'route.passenger': '旅客',
  'route.cargo': '貨物',
  'route.unknown': '分類不明',
  'route.carriers': '航空会社別',
  'route.hidden': '現在のフィルターではこの路線は非表示です。',

  'unit.flights': '{value} 便',
  'unit.km': '{value} km',

  'timeline.label': '月',
  'timeline.play': '月を自動再生',
  'timeline.pause': '一時停止',
  'timeline.prev': '前の月',
  'timeline.next': '次の月',
  'timeline.observedDays': '観測日数 {days} 日',
  'timeline.disabled': '単一スナップショット',

  'globe.autoRotate': '自動回転',
  'globe.zoomIn': 'ズームイン',
  'globe.zoomOut': 'ズームアウト',
  'globe.reset': '視点をリセット',

  'source.title': 'データと出典',
  'source.dataset': 'データセット',
  'source.period': '期間',
  'source.generated': '生成日時',
  'source.license': 'ライセンス',
  'source.basemap': '地図：Natural Earth（world-atlas 経由、パブリックドメイン）',
  'source.close': '閉じる',
  'source.open': 'データと出典',

  'tooltip.clickToSelect': 'クリックで選択',
};

export const MESSAGES = { en, ja } as const;
export type Locale = keyof typeof MESSAGES;
export const LOCALES: readonly Locale[] = ['ja', 'en'];

export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
