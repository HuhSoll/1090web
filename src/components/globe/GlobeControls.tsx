import type { RefObject } from 'react';
import type { GlobeRenderer } from '../../render/globe/GlobeRenderer';
import { useAppStore } from '../../state/store';
import { useI18n } from '../../i18n/useI18n';
import { Icon } from '../common/Icon';

export function GlobeControls({ rendererRef }: { rendererRef: RefObject<GlobeRenderer | null> }) {
  const { t } = useI18n();
  const autoRotate = useAppStore((s) => s.autoRotate);
  const setAutoRotate = useAppStore((s) => s.setAutoRotate);
  const viewMode = useAppStore((s) => s.viewMode);
  return (
    <div className="globe-controls panel" role="toolbar" aria-label="Globe">
      <button type="button" className="icon-btn" onClick={() => rendererRef.current?.zoomBy(0.8)} title={t('globe.zoomIn')} aria-label={t('globe.zoomIn')}>
        <Icon name="plus" />
      </button>
      <button type="button" className="icon-btn" onClick={() => rendererRef.current?.zoomBy(1.25)} title={t('globe.zoomOut')} aria-label={t('globe.zoomOut')}>
        <Icon name="minus" />
      </button>
      <button type="button" className="icon-btn" onClick={() => rendererRef.current?.resetView()} title={t('globe.reset')} aria-label={t('globe.reset')}>
        <Icon name="reset" />
      </button>
      {viewMode === 'globe' && (
      <button
        type="button"
        className={`icon-btn ${autoRotate ? 'is-active' : ''}`}
        onClick={() => setAutoRotate(!autoRotate)}
        title={t('globe.autoRotate')}
        aria-label={t('globe.autoRotate')}
        aria-pressed={autoRotate}
      >
        <Icon name="rotate" />
      </button>
      )}
    </div>
  );
}
