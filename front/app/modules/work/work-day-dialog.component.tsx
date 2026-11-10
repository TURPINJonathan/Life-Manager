import { Button, Dialog, FormField, Icon, IconButton } from '@components';
import { BUTTON_VARIANT, DIALOG_SIZE, FIELD_CONTROL_CLASSES, ICON_BUTTON_VARIANT } from '@constants';
import type { TimeSegmentInput, TimeShortcut } from '@app-types';
import { cn, formatIsoDateFr } from '@utils';

import { formatMinutes } from './work.utils';

export type DayLaneDraft = {
  segments: TimeSegmentInput[];
  pauseMinutes: number;
  notes: string;
  existingId: string | null;
};

type WorkDayDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  workDate: string;
  planned: DayLaneDraft;
  actual: DayLaneDraft;
  shortcuts: TimeShortcut[];
  timeTrackingEnabled: boolean;
  busy?: boolean;
  /** Navigation jour précédent / suivant (ex. pointage depuis l’accueil). */
  onPrevDay?: () => void;
  onNextDay?: () => void;
  onChangePlanned: (next: DayLaneDraft) => void;
  onChangeActual: (next: DayLaneDraft) => void;
  onCopyPlannedToActual: () => void;
  onSave: () => void;
  onDelete: (lane: 'planned' | 'actual') => void;
};

function emptySegment(): TimeSegmentInput {
  return { start: '08:00', end: '12:00' };
}

function segmentSpanMinutes(segments: TimeSegmentInput[], pauseMinutes: number): number {
  let gross = 0;
  for (const seg of segments) {
    const [sh, sm] = seg.start.split(':').map(Number);
    const [eh, em] = seg.end.split(':').map(Number);
    const start = sh * 60 + sm;
    let end = eh * 60 + em;
    if (end === 0 && start > 0) end = 24 * 60;
    gross += Math.max(0, end - start);
  }
  return Math.max(0, gross - pauseMinutes);
}

function LaneEditor({
  draft,
  onChange,
  shortcuts,
  showShortcuts,
  idPrefix,
}: {
  draft: DayLaneDraft;
  onChange: (next: DayLaneDraft) => void;
  shortcuts: TimeShortcut[];
  showShortcuts: boolean;
  idPrefix: string;
}) {
  const segments = draft.segments.length > 0 ? draft.segments : [emptySegment()];

  return (
    <div className="flex flex-col gap-3">
      {showShortcuts && shortcuts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {shortcuts.map((shortcut) => (
            <button
              key={shortcut.id}
              type="button"
              onClick={() =>
                onChange({
                  ...draft,
                  segments: shortcut.segments.map((s) => ({ ...s })),
                  pauseMinutes: shortcut.pauseMinutes,
                })
              }
              className="inline-flex cursor-pointer items-center gap-1 rounded-control border border-border-subtle bg-subtle px-2.5 py-1.5 text-control text-fg-secondary transition hover:border-accent hover:bg-accent-tint hover:text-accent-press"
            >
              <Icon name="bolt" className="text-icon-sm" />
              {shortcut.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 rounded-control border border-border-subtle bg-page p-3 dark:bg-elevated">
        {segments.map((segment, index) => (
          <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
            <FormField label={index === 0 ? 'Début' : undefined} htmlFor={`${idPrefix}-start-${index}`}>
              <input
                id={`${idPrefix}-start-${index}`}
                type="time"
                className={FIELD_CONTROL_CLASSES}
                value={segment.start}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    segments: segments.map((s, i) => (i === index ? { ...s, start: e.target.value } : s)),
                  })
                }
              />
            </FormField>
            <span className="hidden text-fg-muted sm:mb-2.5 sm:inline">→</span>
            <FormField label={index === 0 ? 'Fin' : undefined} htmlFor={`${idPrefix}-end-${index}`}>
              <input
                id={`${idPrefix}-end-${index}`}
                type="time"
                className={FIELD_CONTROL_CLASSES}
                value={segment.end}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    segments: segments.map((s, i) => (i === index ? { ...s, end: e.target.value } : s)),
                  })
                }
              />
            </FormField>
            <IconButton
              variant={ICON_BUTTON_VARIANT.ghost}
              icon="close"
              aria-label="Retirer le créneau"
              className="justify-self-end sm:mb-0.5 sm:justify-self-auto"
              disabled={segments.length <= 1}
              onClick={() =>
                onChange({
                  ...draft,
                  segments: segments.filter((_, i) => i !== index),
                })
              }
            />
          </div>
        ))}
        <Button
          type="button"
          variant={BUTTON_VARIANT.ghost}
          fullWidth={false}
          className="h-9 w-auto self-start px-2"
          onClick={() => onChange({ ...draft, segments: [...segments, emptySegment()] })}
        >
          <Icon name="add" className="text-icon-sm" />
          Créneau
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
        <FormField label="Pause (min)" htmlFor={`${idPrefix}-pause`}>
          <input
            id={`${idPrefix}-pause`}
            type="number"
            min={0}
            className={FIELD_CONTROL_CLASSES}
            value={draft.pauseMinutes}
            onChange={(e) => onChange({ ...draft, pauseMinutes: Number(e.target.value) || 0 })}
          />
        </FormField>
        <FormField label="Notes" htmlFor={`${idPrefix}-notes`}>
          <input
            id={`${idPrefix}-notes`}
            className={FIELD_CONTROL_CLASSES}
            value={draft.notes}
            onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            placeholder="Optionnel"
          />
        </FormField>
      </div>

      <p className="text-control tabular-nums text-fg-secondary">
        Total :{' '}
        <strong className="text-fg-primary">{formatMinutes(segmentSpanMinutes(segments, draft.pauseMinutes))}</strong>
      </p>
    </div>
  );
}

function LaneColumn({
  title,
  idPrefix,
  draft,
  onChange,
  shortcuts,
  busy,
  onDelete,
}: {
  title: string;
  idPrefix: string;
  draft: DayLaneDraft;
  onChange: (next: DayLaneDraft) => void;
  shortcuts: TimeShortcut[];
  busy: boolean;
  onDelete?: () => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{title}</p>
          <p className="text-title font-semibold tabular-nums">
            {formatMinutes(segmentSpanMinutes(draft.segments, draft.pauseMinutes))}
          </p>
        </div>
        {onDelete ? (
          <Button
            type="button"
            variant={BUTTON_VARIANT.dangerOutline}
            fullWidth={false}
            className="h-9 w-auto px-3"
            disabled={busy}
            onClick={onDelete}
          >
            Supprimer
          </Button>
        ) : null}
      </div>
      <LaneEditor draft={draft} onChange={onChange} shortcuts={shortcuts} showShortcuts idPrefix={idPrefix} />
    </section>
  );
}

export function WorkDayDialog({
  isOpen,
  onClose,
  workDate,
  planned,
  actual,
  shortcuts,
  timeTrackingEnabled,
  busy = false,
  onPrevDay,
  onNextDay,
  onChangePlanned,
  onChangeActual,
  onCopyPlannedToActual,
  onSave,
  onDelete,
}: WorkDayDialogProps) {
  const canCopyPlanned = timeTrackingEnabled && planned.segments.length > 0;
  const canNavigate = Boolean(onPrevDay || onNextDay);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Journée"
      icon="schedule"
      size={timeTrackingEnabled ? DIALOG_SIZE.wide : DIALOG_SIZE.large}
    >
      <div className="mt-2 flex flex-col gap-4">
        {canNavigate ? (
          <div className="flex items-center justify-center gap-1">
            <IconButton
              variant={ICON_BUTTON_VARIANT.ghost}
              icon="chevron_left"
              aria-label="Jour précédent"
              disabled={busy || !onPrevDay}
              onClick={onPrevDay}
            />
            <p className="min-w-0 flex-1 text-center text-control font-medium text-fg-primary sm:px-2">
              {formatIsoDateFr(workDate, { weekday: 'long' })}
            </p>
            <IconButton
              variant={ICON_BUTTON_VARIANT.ghost}
              icon="chevron_right"
              aria-label="Jour suivant"
              disabled={busy || !onNextDay}
              onClick={onNextDay}
            />
          </div>
        ) : (
          <p className="text-control text-fg-muted">{formatIsoDateFr(workDate, { weekday: 'long' })}</p>
        )}

        <div className={cn('grid items-start gap-6', timeTrackingEnabled && 'lg:grid-cols-2')}>
          <LaneColumn
            title="Prévu"
            idPrefix="planned"
            draft={planned}
            onChange={onChangePlanned}
            shortcuts={shortcuts}
            busy={busy}
            onDelete={planned.existingId ? () => onDelete('planned') : undefined}
          />
          {timeTrackingEnabled ? (
            <LaneColumn
              title="Réel"
              idPrefix="actual"
              draft={actual}
              onChange={onChangeActual}
              shortcuts={shortcuts}
              busy={busy}
              onDelete={actual.existingId ? () => onDelete('actual') : undefined}
            />
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
          {timeTrackingEnabled ? (
            <Button
              type="button"
              variant={BUTTON_VARIANT.neutral}
              fullWidth={false}
              className="w-auto px-3"
              disabled={busy || !canCopyPlanned}
              onClick={onCopyPlannedToActual}
            >
              <Icon name="content_copy" className="text-icon-sm" />
              Copier le prévu → réel
            </Button>
          ) : null}
          <div className="ms-auto flex flex-wrap gap-2">
            <Button
              type="button"
              variant={BUTTON_VARIANT.dangerOutline}
              fullWidth={false}
              className="w-auto px-3"
              disabled={busy}
              onClick={onClose}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant={BUTTON_VARIANT.success}
              fullWidth={false}
              className="w-auto px-4"
              loading={busy}
              onClick={onSave}
            >
              Enregistrer
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export { emptySegment, segmentSpanMinutes };
