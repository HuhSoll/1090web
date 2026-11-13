import type { MessageKey } from '../../i18n/messages';
import type { useI18n } from '../../i18n/useI18n';
import type { ScenarioIssue } from '../../simulation/model';

/** Messages for scenario problems (validation, file import). */
export function issueText(t: ReturnType<typeof useI18n>['t'], i: ScenarioIssue): string {
  switch (i.code) {
    case 'unknown_airport':
    case 'unknown_route':
      return t(`sim.issue.${i.code}`, { id: i.id });
    case 'newer_schema':
    case 'older_schema':
      return t(`sim.issue.${i.code}`, { version: i.version });
    case 'dataset_id_differs':
    case 'dataset_version_differs':
      return t(`sim.issue.${i.code}`, { value: i.value ?? '—' });
    case 'dropped_field':
      return t('sim.issue.dropped_field', { field: i.field });
    default:
      return t(`sim.issue.${i.code}` as MessageKey);
  }
}
