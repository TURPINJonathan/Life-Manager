import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Dialog, Icon, Popover } from '@components';
import {
  FIELD_CONTROL_CLASSES,
  INPUT_STATE_CLASSES,
  POPOVER_PLACEMENT,
  SELECT_OPTION_ROW_CLASSES,
  SELECT_OPTION_STATE_CLASSES,
  SELECT_PANEL_FALLBACK_LABEL,
  SELECT_TRIGGER_CLASSES,
  TABLET_MEDIA_QUERY,
} from '@constants';
import { useDismissiblePanel, useMediaQuery } from '@hooks';
import type { SelectOption } from '@app-types';
import { cn, normalizeSearch } from '@utils';

type SelectCreateOption = {
  label: string;
  onCreate: () => void;
};

type SelectProps = {
  className?: string;
  disabled?: boolean;
  error?: boolean;
  id?: string;
  label?: string;
  name?: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Dernière entrée du menu — ouvre une création à la volée sans changer la valeur. */
  createOption?: SelectCreateOption;
  placeholder?: string;
  value: string;
  /** Champ de recherche en tête du panneau (défaut : true). */
  searchable?: boolean;
  searchPlaceholder?: string;
};

type OptionListProps = {
  ariaLabel: string;
  createOption?: SelectCreateOption;
  listboxId: string;
  onSelect: (value: string) => void;
  options: readonly SelectOption[];
  value: string;
  emptyLabel?: string;
};

const OPTION_SELECTOR = '[role="option"]';

function filterSelectOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = normalizeSearch(query);
  if (!needle) return [...options];

  const result: SelectOption[] = [];
  let pendingHeading: SelectOption | null = null;

  for (const option of options) {
    if (option.heading) {
      pendingHeading = option;
      continue;
    }
    if (!normalizeSearch(option.label).includes(needle)) continue;
    if (pendingHeading) {
      result.push(pendingHeading);
      pendingHeading = null;
    }
    result.push(option);
  }

  return result;
}

function OptionList({
  ariaLabel,
  createOption,
  listboxId,
  onSelect,
  options,
  value,
  emptyLabel = 'Aucun résultat',
}: OptionListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectableCount = options.filter((option) => !option.heading).length;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR) ?? []);
    if (rows.length === 0) return;

    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (current + 1) % rows.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + rows.length) % rows.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;

    if (next === -1) return;
    event.preventDefault();
    rows[next]?.focus();
  }

  return (
    <div
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      className="flex flex-col gap-0.5"
      onKeyDown={handleKeyDown}
    >
      {selectableCount === 0 ? (
        <p className="px-3 py-3 text-body text-fg-muted">{emptyLabel}</p>
      ) : (
        options.map((option) => {
          if (option.heading) {
            return (
              <div
                key={`heading-${option.label}-${option.value}`}
                role="presentation"
                className="mt-1.5 flex items-center gap-2 px-3 pt-2 pb-1 first:mt-0"
              >
                {option.leading}
                <span className="text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{option.label}</span>
              </div>
            );
          }

          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(option.value)}
              className={cn(
                SELECT_OPTION_ROW_CLASSES,
                selected ? SELECT_OPTION_STATE_CLASSES.selected : SELECT_OPTION_STATE_CLASSES.default,
              )}
            >
              {option.leading}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.trailing ? <span className="ms-2 shrink-0">{option.trailing}</span> : null}
              {selected && <Icon name="check" className="shrink-0 text-icon-sm text-accent" />}
            </button>
          );
        })
      )}

      {createOption ? (
        <>
          <div role="presentation" className="my-1 border-t border-border-subtle" />
          <button
            type="button"
            role="option"
            aria-selected={false}
            tabIndex={-1}
            onClick={createOption.onCreate}
            className={cn(SELECT_OPTION_ROW_CLASSES, SELECT_OPTION_STATE_CLASSES.default, 'text-accent')}
          >
            <Icon name="add" className="shrink-0 text-icon-sm" />
            <span className="min-w-0 flex-1 truncate font-medium">{createOption.label}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Select({
  className,
  disabled,
  error,
  id,
  label,
  name,
  onChange,
  options,
  createOption,
  placeholder,
  value,
  searchable = true,
  searchPlaceholder = 'Rechercher…',
}: SelectProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const listboxId = `${fieldId}-listbox`;
  const searchId = `${fieldId}-search`;
  const isTablet = useMediaQuery(TABLET_MEDIA_QUERY);
  const { isOpen, open, close, triggerRef } = useDismissiblePanel();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    close();
  }, [isTablet, close]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      return;
    }
    if (!searchable) return;
    // Sur tactile, l’autofocus ouvre le clavier et contribue aux gels PWA après fermeture.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, searchable]);

  const listOptions = useMemo(() => {
    const base =
      placeholder === undefined
        ? [...options]
        : [{ value: '', label: placeholder, leading: undefined as ReactNode }, ...options];
    return searchable ? filterSelectOptions(base, query) : base;
  }, [options, placeholder, query, searchable]);

  const selectedOption =
    (placeholder === undefined ? options : [{ value: '', label: placeholder }, ...options]).find(
      (option) => option.value === value,
    ) ?? undefined;
  const panelLabel = label ?? SELECT_PANEL_FALLBACK_LABEL;

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (isOpen) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
      return;
    }
    if (searchable && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setQuery(event.key);
      open();
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const first = document.querySelector<HTMLButtonElement>(`#${CSS.escape(listboxId)} ${OPTION_SELECTOR}`);
      first?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  function handleSelect(nextValue: string): void {
    close();
    onChange(nextValue);
  }

  function handleCreate(): void {
    close();
    createOption?.onCreate();
  }

  const optionList = (
    <OptionList
      ariaLabel={panelLabel}
      listboxId={listboxId}
      onSelect={handleSelect}
      options={listOptions}
      value={value}
      createOption={createOption ? { label: createOption.label, onCreate: handleCreate } : undefined}
    />
  );

  const panelBody = (
    <div className="flex min-h-0 flex-col gap-2">
      {searchable ? (
        <div className="relative shrink-0">
          <Icon
            name="search"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-icon-sm text-fg-muted"
          />
          <input
            ref={searchRef}
            id={searchId}
            data-autofocus
            type="search"
            value={query}
            placeholder={searchPlaceholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            className={cn(FIELD_CONTROL_CLASSES, 'h-11 pl-10')}
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
          />
        </div>
      ) : null}
      <div className="min-h-0 max-h-[min(50dvh,22rem)] overflow-y-auto">{optionList}</div>
    </div>
  );

  return (
    <div className={cn('min-w-0', className)}>
      <button
        ref={triggerRef}
        type="button"
        id={fieldId}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-autocomplete={searchable ? 'list' : undefined}
        aria-invalid={error || undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(SELECT_TRIGGER_CLASSES, error ? INPUT_STATE_CLASSES.error : INPUT_STATE_CLASSES.default)}
      >
        {selectedOption?.leading}
        <span className="min-w-0 flex-1 truncate text-left">{selectedOption?.label ?? value}</span>
        {selectedOption?.trailing ? <span className="ms-2 shrink-0">{selectedOption.trailing}</span> : null}
        <Icon name={searchable ? 'search' : 'expand_more'} className="ml-auto shrink-0 text-fg-muted" />
      </button>

      {isTablet ? (
        <Popover
          isOpen={isOpen}
          onClose={close}
          anchorRef={triggerRef}
          placement={POPOVER_PLACEMENT.bottomStart}
          label={panelLabel}
        >
          <div className="min-w-[min(100vw-2rem,20rem)] p-1">{panelBody}</div>
        </Popover>
      ) : (
        <Dialog isOpen={isOpen} onClose={close} title={panelLabel}>
          <div className="mt-3">{panelBody}</div>
        </Dialog>
      )}
    </div>
  );
}
