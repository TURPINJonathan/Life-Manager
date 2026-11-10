import { useState, type FormEvent } from 'react';

import { Button, Icon } from '@components';
import { BUTTON_VARIANT, FIELD_CONTROL_CLASSES } from '@constants';
import { cn, formatCents, parseEurosToCents, signedAmountClass } from '@utils';

export type ProjectionShortcut = {
  id: string;
  label: string;
  hint?: string;
  cents: number;
};

type ForecastProjectionPopoverProps = {
  shortcuts: ProjectionShortcut[];
  activeCents: number | null;
  apiOpeningCents: number;
  loadingShortcuts?: boolean;
  daysInMonth: number;
  activeDay: number | null;
  onSelect: (cents: number) => void;
  onSelectDay: (day: number | null) => void;
  onReset: () => void;
};

const DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

export function ForecastProjectionPopover({
  shortcuts,
  activeCents,
  apiOpeningCents,
  loadingShortcuts = false,
  daysInMonth,
  activeDay,
  onSelect,
  onSelectDay,
  onReset,
}: ForecastProjectionPopoverProps) {
  const [customAmount, setCustomAmount] = useState('');
  const customCents = parseEurosToCents(customAmount);
  const customValid = customCents !== null;
  const maxDay = Math.min(31, Math.max(28, daysInMonth));
  const hasOverride = activeCents !== null || activeDay !== null;

  const applyCustom = (event: FormEvent) => {
    event.preventDefault();
    if (customCents === null) return;
    onSelect(customCents);
    setCustomAmount('');
  };

  return (
    <div className="flex w-[min(100vw-2rem,22rem)] flex-col gap-2 p-1">
      <div className="px-1 pt-0.5">
        <p className="text-control font-semibold text-fg-primary">Projection locale</p>
        <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
          Recalcule les soldes de ce mois uniquement — rien n’est enregistré.
        </p>
      </div>

      <div className="flex flex-col gap-1.5 border-b border-border-subtle px-1 pb-2">
        <div>
          <p className="text-control font-medium text-fg-secondary">À un jour du mois</p>
          <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
            Échéances dues à 100 % ; flexibles lissés sur le mois (plan tenu).
          </p>
        </div>
        <button
          type="button"
          onClick={() => onSelectDay(null)}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-control border px-2.5 py-1.5 text-left text-[11px] transition-colors',
            activeDay === null
              ? 'border-accent bg-accent-tint text-accent-press'
              : 'border-border-subtle bg-page text-fg-muted hover:border-border hover:text-fg-secondary dark:bg-elevated',
          )}
        >
          <Icon name="event_available" className="text-[1rem]!" />
          <span className="font-medium">Fin de mois</span>
        </button>
        <div className="rounded-control border border-border-subtle bg-page p-1.5 dark:bg-elevated">
          <div className="grid grid-cols-7 gap-0.5">
            {DAYS.filter((day) => day <= maxDay).map((day) => {
              const selected = activeDay === day;
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => onSelectDay(day)}
                  className={cn(
                    'flex aspect-square cursor-pointer items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    selected
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-fg-secondary hover:bg-accent-tint hover:text-accent-press',
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        <p className="px-1 text-control font-medium text-fg-secondary">Depuis un solde</p>
        {loadingShortcuts ? <p className="px-2 py-2 text-control text-fg-muted">Chargement des raccourcis…</p> : null}
        {shortcuts.map((item) => {
          const selected = activeCents === item.cents;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.cents)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-2 text-left transition-colors',
                selected ? 'bg-accent-tint' : 'hover:bg-subtle dark:hover:bg-elevated',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-control font-medium text-fg-primary">{item.label}</span>
                {item.hint ? (
                  <span className="mt-0.5 block truncate text-[11px] text-fg-muted">{item.hint}</span>
                ) : null}
              </span>
              <span className={cn('shrink-0 tabular-nums text-control font-semibold', signedAmountClass(item.cents))}>
                {formatCents(item.cents)}
              </span>
            </button>
          );
        })}
      </div>

      <form onSubmit={applyCustom} className="flex flex-col gap-1.5 border-t border-border-subtle px-1 pt-2">
        <label htmlFor="forecast-projection-custom" className="text-control font-medium text-fg-secondary">
          Montant libre
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="forecast-projection-custom"
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            value={customAmount}
            onChange={(event) => setCustomAmount(event.target.value)}
            className={cn(FIELD_CONTROL_CLASSES, 'h-9 min-w-0 flex-1 px-2 text-control tabular-nums')}
          />
          <Button
            type="submit"
            variant={BUTTON_VARIANT.primary}
            fullWidth={false}
            disabled={!customValid}
            className="h-9 w-auto shrink-0 px-2.5 text-control"
            aria-label="Appliquer le montant"
          >
            <Icon name="check" className="text-icon-sm" />
          </Button>
        </div>
      </form>

      {hasOverride ? (
        <div className="border-t border-border-subtle px-1 pt-2">
          <Button
            type="button"
            variant={BUTTON_VARIANT.neutral}
            fullWidth
            className="h-9 text-control"
            onClick={onReset}
          >
            Réinitialiser
            {activeCents !== null ? ` (${formatCents(apiOpeningCents)})` : ''}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
