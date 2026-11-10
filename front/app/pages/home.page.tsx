import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { ConfirmDialog, EmptyState, Icon, Typography } from '@components';
import {
  APP_ACCENT,
  APP_PAGE_FILL_CLASSES,
  APP_PAGE_GUTTER_CLASSES,
  APP_ROUTE,
  accountLedgerPath,
  currentYearMonth,
  settingsPath,
} from '@constants';
import {
  aggregateDashboardForecast,
  budgetStatusLabel,
  collectUpcomingDeadlines,
  formatMonthLabel,
  monthDisplayBalanceCents,
} from '@accounts';
import { DEFAULT_DAY_SHORTCUT, WorkDayDialog, addDaysIso, formatMinutes, type DayLaneDraft } from '@work';
import {
  deletePlanEntry,
  deleteTimeEntry,
  fetchForecastStatsDashboard,
  fetchWorkDashboard,
  listAccounts,
  listPlanEntries,
  listTimeEntries,
  listTimeShortcuts,
  upsertPlanEntry,
  upsertTimeEntry,
} from '@services';
import { useAuthStore } from '@store';
import type {
  Account,
  ForecastStats,
  TimeEntry,
  TimeShortcut,
  WorkDashboard,
  WorkDashboardJobRow,
  WorkJob,
  WorkPlanEntry,
} from '@app-types';
import { cn, formatCents, signedAmountClass, toastFromError, toastInfo, toastSuccess, todayIsoLocal } from '@utils';

function OverviewSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-hidden="true">
      <div className="h-64 animate-pulse rounded-panel bg-subtle" />
      <div className="h-64 animate-pulse rounded-panel bg-subtle" />
      <div className="h-36 animate-pulse rounded-panel bg-subtle lg:col-span-2" />
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  valueClassName,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClassName?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col justify-center rounded-control border border-border-subtle/80 bg-elevated/70 px-2.5 py-2',
        className,
      )}
    >
      <p className="truncate text-[11px] text-fg-muted">{label}</p>
      <p className={cn('mt-0.5 truncate text-control font-semibold tabular-nums', valueClassName)}>{value}</p>
      {hint ? <p className="mt-0.5 truncate text-[11px] text-fg-muted">{hint}</p> : null}
    </div>
  );
}

function FlowMetric({
  label,
  plannedCents,
  actualCents,
  tone,
  className,
}: {
  label: string;
  plannedCents: number;
  actualCents: number;
  tone: 'income' | 'expense';
  className?: string;
}) {
  const delta = actualCents - plannedCents;
  const percent = plannedCents > 0 ? Math.round((actualCents / plannedCents) * 100) : null;
  const over = tone === 'expense' && percent !== null && percent > 100;
  const valueTone = tone === 'income' ? 'text-success-strong' : over ? 'text-error' : 'text-error';

  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col justify-center gap-1 rounded-control border border-border-subtle/80 bg-elevated/70 px-2.5 py-2.5 sm:px-3 sm:py-3',
        className,
      )}
    >
      <p className="truncate text-[11px] font-medium text-fg-muted sm:text-control">{label}</p>
      <p
        className={cn(
          'truncate text-[1.15rem] font-bold leading-none tracking-tight tabular-nums sm:text-[1.35rem]',
          valueTone,
        )}
      >
        {formatCents(plannedCents)}
      </p>
      <p className="truncate text-[11px] text-fg-muted sm:text-control">
        Réalisé <span className={cn('font-semibold tabular-nums', valueTone)}>{formatCents(actualCents)}</span>
        {percent !== null ? <span className="text-fg-muted"> · {percent}%</span> : null}
      </p>
      <p
        className={cn(
          'truncate text-[11px] font-medium tabular-nums sm:text-control',
          delta === 0 ? 'text-fg-muted' : delta > 0 ? 'text-success-strong' : 'text-error',
        )}
      >
        Écart {delta > 0 ? '+' : delta < 0 ? '−' : ''}
        {formatCents(Math.abs(delta))}
      </p>
    </div>
  );
}

function emptyLane(): DayLaneDraft {
  return {
    segments: DEFAULT_DAY_SHORTCUT.segments.map((segment) => ({ ...segment })),
    pauseMinutes: DEFAULT_DAY_SHORTCUT.pauseMinutes,
    notes: '',
    existingId: null,
  };
}

function laneFromEntry(entry: TimeEntry | null): DayLaneDraft {
  if (!entry) return emptyLane();
  return {
    segments: entry.segments.map((segment) => ({ start: segment.start, end: segment.end })),
    pauseMinutes: entry.pauseMinutes,
    notes: entry.notes ?? '',
    existingId: entry.id,
  };
}

function laneFromPlan(entry: WorkPlanEntry | null): DayLaneDraft {
  if (!entry) return emptyLane();
  return {
    segments: entry.segments.map((segment) => ({ start: segment.start, end: segment.end })),
    pauseMinutes: entry.pauseMinutes,
    notes: entry.notes ?? '',
    existingId: entry.id,
  };
}

type TrackableJob = {
  workerName: string;
  showWorker: boolean;
  row: WorkDashboardJobRow;
};

type ClockSession = {
  job: WorkJob;
  workDate: string;
  planned: DayLaneDraft;
  actual: DayLaneDraft;
  shortcuts: TimeShortcut[];
  plannedDirty: boolean;
  actualDirty: boolean;
};

type PendingDelete = { lane: 'planned' | 'actual'; id: string };

export function HomePage() {
  const token = useAuthStore((state) => state.token);
  const yearMonth = currentYearMonth();
  const monthLabel = useMemo(() => formatMonthLabel(yearMonth), [yearMonth]);
  const today = todayIsoLocal();

  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [statsBySubId, setStatsBySubId] = useState<Record<string, ForecastStats | null>>({});
  const [work, setWork] = useState<WorkDashboard | null>(null);

  const [clockOpen, setClockOpen] = useState(false);
  const [clockBusy, setClockBusy] = useState(false);
  const [clockLoading, setClockLoading] = useState(false);
  const [clock, setClock] = useState<ClockSession | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const reloadHome = async () => {
    if (!token) return;
    const [accountRows, forecastDashboard, workDashboard] = await Promise.all([
      listAccounts(token),
      fetchForecastStatsDashboard(token, yearMonth, false),
      fetchWorkDashboard(token, yearMonth),
    ]);
    setAccounts(accountRows);
    setStatsBySubId(forecastDashboard.current);
    setWork(workDashboard);
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await reloadHome();
      } catch (err) {
        if (!cancelled) toastFromError(err, 'Chargement de l’accueil impossible.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, yearMonth]);

  const flatSubs = useMemo(
    () =>
      accounts.flatMap((account) =>
        account.subAccounts.map((sub) => ({
          ...sub,
          accountName: account.name,
        })),
      ),
    [accounts],
  );

  const displayBalanceBySubId = useMemo(() => {
    const map: Record<string, number> = {};
    for (const sub of flatSubs) {
      map[sub.id] = monthDisplayBalanceCents(statsBySubId[sub.id], sub.provisionalBalanceCents);
    }
    return map;
  }, [flatSubs, statsBySubId]);

  const totalBalanceCents = useMemo(
    () => flatSubs.reduce((sum, sub) => sum + (displayBalanceBySubId[sub.id] ?? 0), 0),
    [flatSubs, displayBalanceBySubId],
  );

  const forecast = useMemo(
    () => aggregateDashboardForecast(yearMonth, flatSubs, statsBySubId),
    [yearMonth, flatSubs, statsBySubId],
  );

  const deadlines = useMemo(
    () => collectUpcomingDeadlines(flatSubs, statsBySubId, 4, yearMonth),
    [flatSubs, statsBySubId, yearMonth],
  );

  const trackableJobs = useMemo((): TrackableJob[] => {
    if (!work) return [];
    const multiWorker = work.workers.length > 1;
    const rows: TrackableJob[] = [];
    for (const worker of work.workers) {
      for (const row of worker.jobs) {
        if (!row.job.timeTrackingEnabled) continue;
        rows.push({
          workerName: worker.fullName,
          showWorker: multiWorker,
          row,
        });
      }
    }
    return rows;
  }, [work]);

  const hasAccounts = flatSubs.length > 0;
  const hasJobs = (work?.workers ?? []).some((worker) => worker.jobs.length > 0);

  const loadClockDay = async (job: WorkJob, workDate: string, shortcuts?: TimeShortcut[]) => {
    if (!token) return;
    const [entries, plans, nextShortcuts] = await Promise.all([
      listTimeEntries(token, job.id, workDate, workDate),
      listPlanEntries(token, job.id, workDate, workDate),
      shortcuts ? Promise.resolve(shortcuts) : listTimeShortcuts(token, job.id),
    ]);
    setClock({
      job,
      workDate,
      planned: laneFromPlan(plans[0] ?? null),
      actual: laneFromEntry(entries[0] ?? null),
      shortcuts: nextShortcuts,
      plannedDirty: false,
      actualDirty: false,
    });
  };

  const openClock = async (job: WorkJob) => {
    if (!token) return;
    setClockLoading(true);
    setClockOpen(true);
    try {
      await loadClockDay(job, today);
    } catch (err) {
      toastFromError(err, 'Ouverture du pointage impossible.');
      setClockOpen(false);
      setClock(null);
    } finally {
      setClockLoading(false);
    }
  };

  const shiftClockDay = async (delta: number) => {
    if (!token || !clock || clockBusy || clockLoading) return;
    if (clock.plannedDirty || clock.actualDirty) {
      toastInfo('Enregistre la journée avant de changer de date.');
      return;
    }
    const nextDate = addDaysIso(clock.workDate, delta);
    setClockLoading(true);
    try {
      await loadClockDay(clock.job, nextDate, clock.shortcuts);
    } catch (err) {
      toastFromError(err, 'Chargement du jour impossible.');
    } finally {
      setClockLoading(false);
    }
  };

  const closeClock = () => {
    setClockOpen(false);
    setClock(null);
    setPendingDelete(null);
  };

  const saveClock = async () => {
    if (!token || !clock) return;
    setClockBusy(true);
    let saved = false;
    try {
      const tracking = clock.job.timeTrackingEnabled;
      const shouldSavePlanned = !tracking || clock.plannedDirty;
      const shouldSaveActual = tracking && (clock.actualDirty || !clock.plannedDirty);

      if (shouldSavePlanned) {
        await upsertPlanEntry(token, clock.job.id, {
          workDate: clock.workDate,
          segments: clock.planned.segments,
          pauseMinutes: clock.planned.pauseMinutes,
          notes: clock.planned.notes || null,
        });
      }
      if (shouldSaveActual) {
        await upsertTimeEntry(token, clock.job.id, {
          workDate: clock.workDate,
          segments: clock.actual.segments,
          pauseMinutes: clock.actual.pauseMinutes,
          notes: clock.actual.notes || null,
        });
      }
      if (shouldSavePlanned && shouldSaveActual) toastSuccess('Journée enregistrée.');
      else if (shouldSavePlanned) toastSuccess('Planning enregistré.');
      else toastSuccess('Pointage enregistré.');
      // Fermer avant le reload : évite un dialog coincé si le rechargement traîne (PWA mobile).
      closeClock();
      saved = true;
    } catch (err) {
      toastFromError(err, 'Enregistrement impossible.');
    } finally {
      setClockBusy(false);
    }
    if (saved) await reloadHome();
  };

  const confirmDeleteLane = async () => {
    if (!token || !pendingDelete) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.lane === 'actual') {
        await deleteTimeEntry(token, pendingDelete.id);
        toastSuccess('Pointage supprimé.');
        setClock((prev) =>
          prev
            ? {
                ...prev,
                actual: emptyLane(),
                actualDirty: false,
              }
            : prev,
        );
      } else {
        await deletePlanEntry(token, pendingDelete.id);
        toastSuccess('Planning supprimé.');
        setClock((prev) =>
          prev
            ? {
                ...prev,
                planned: emptyLane(),
                plannedDirty: false,
              }
            : prev,
        );
      }
      setPendingDelete(null);
      await reloadHome();
    } catch (err) {
      toastFromError(err, 'Suppression impossible.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className={`${APP_PAGE_FILL_CLASSES} overflow-y-auto`} data-app-scroll>
      <section className={`${APP_PAGE_GUTTER_CLASSES} flex flex-col gap-5`}>
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="mt-1 text-body text-fg-secondary">
              Vue d’ensemble · <span className="font-medium text-fg-primary">{monthLabel}</span>
            </p>
          </div>
        </header>

        {loading ? (
          <OverviewSkeleton />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
            <section
              data-accent={APP_ACCENT.accounts}
              className="relative flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-panel border border-accent/20 bg-accent-tint/60 p-3"
            >
              <Icon
                name="account_balance_wallet"
                aria-hidden
                className="pointer-events-none absolute top-1/2 -right-10 -translate-y-1/2 text-[10rem]! leading-none text-accent opacity-[0.12]"
              />
              <div className="relative z-10 flex shrink-0 items-center gap-2">
                <Icon name="account_balance_wallet" className="text-icon-sm text-accent-press" />
                <Typography variant="title" className="min-w-0 flex-1">
                  Comptes
                </Typography>
                <Link
                  to={APP_ROUTE.accounts}
                  className="inline-flex items-center gap-1 text-control font-medium text-fg-secondary no-underline hover:text-accent-press"
                >
                  Voir
                  <Icon name="arrow_forward" className="text-icon-sm" />
                </Link>
              </div>

              {!hasAccounts ? (
                <EmptyState
                  icon="account_balance_wallet"
                  title="Aucun compte"
                  message="Ajoute un compte dans les paramètres pour voir les soldes ici."
                  className="relative z-10 flex-1 py-6"
                />
              ) : (
                <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-3">
                  <div className="shrink-0">
                    <p className="text-[11px] text-fg-muted">Solde combiné</p>
                    <p
                      className={cn(
                        'mt-0.5 text-[1.65rem] font-bold leading-none tracking-tight tabular-nums',
                        signedAmountClass(totalBalanceCents),
                      )}
                    >
                      {formatCents(totalBalanceCents)}
                    </p>
                    <p className="mt-1.5 text-[11px] text-fg-muted">
                      Fin estimée{' '}
                      <span
                        className={cn(
                          'font-semibold tabular-nums',
                          signedAmountClass(forecast.balances.projectedRealisticCents),
                        )}
                      >
                        {formatCents(forecast.balances.projectedRealisticCents)}
                      </span>
                      {forecast.withBudgetCount > 0 ? (
                        <>
                          <span className="mx-1.5 text-border">·</span>
                          {forecast.withBudgetCount}/{forecast.totalSubsCount} budget
                          {forecast.withBudgetCount > 1 ? 's' : ''}
                        </>
                      ) : null}
                    </p>
                  </div>

                  <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
                    <FlowMetric
                      className="h-full"
                      label="Revenus"
                      plannedCents={forecast.totals.plannedIncomeCents}
                      actualCents={forecast.totals.actualIncomeCents}
                      tone="income"
                    />
                    <FlowMetric
                      className="h-full"
                      label="Dépenses"
                      plannedCents={forecast.totals.plannedExpenseCents}
                      actualCents={forecast.totals.actualExpenseCents}
                      tone="expense"
                    />
                  </div>
                </div>
              )}
            </section>

            <section
              data-accent={APP_ACCENT.work}
              className="relative flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-panel border border-accent/20 bg-accent-tint/60 p-3"
            >
              <Icon
                name="work"
                aria-hidden
                className="pointer-events-none absolute top-1/2 -right-10 -translate-y-1/2 text-[10rem]! leading-none text-accent opacity-[0.12]"
              />
              <div className="relative z-10 flex shrink-0 items-center gap-2">
                <Icon name="work" className="text-icon-sm text-accent-press" />
                <Typography variant="title" className="min-w-0 flex-1">
                  Travail
                </Typography>
                {hasJobs ? (
                  <Link
                    to={APP_ROUTE.work}
                    className="inline-flex items-center gap-1 text-control font-medium text-fg-secondary no-underline hover:text-accent-press"
                  >
                    Voir
                    <Icon name="arrow_forward" className="text-icon-sm" />
                  </Link>
                ) : null}
              </div>

              {!hasJobs || !work ? (
                <EmptyState
                  icon="work"
                  title="Aucun emploi"
                  message="Crée un emploi dans les paramètres pour suivre les heures ici."
                  className="relative z-10 flex-1 py-6"
                  action={
                    <Link
                      to={settingsPath('travail')}
                      className="mt-1 inline-flex h-9 items-center justify-center rounded-control bg-accent px-3 text-control font-medium text-white hover:bg-accent-press"
                    >
                      Paramètres travail
                    </Link>
                  }
                />
              ) : (
                <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-3">
                  <div className="shrink-0">
                    <p className="text-[11px] text-fg-muted">Heures du mois</p>
                    <p className="mt-0.5 text-[1.65rem] font-bold leading-none tracking-tight tabular-nums text-brand">
                      {formatMinutes(work.totals.actualMinutes)}
                    </p>
                    <p className="mt-1.5 text-[11px] text-fg-muted">
                      Prévu{' '}
                      <span className="font-semibold text-fg-secondary">
                        {formatMinutes(work.totals.plannedMinutes)}
                      </span>
                      <span className="mx-1.5 text-border">·</span>
                      Écart{' '}
                      <span
                        className={cn(
                          'font-semibold',
                          work.totals.deltaMinutes < 0 ? 'text-error' : 'text-success-strong',
                        )}
                      >
                        {work.totals.deltaMinutes >= 0 ? '+' : '−'}
                        {formatMinutes(Math.abs(work.totals.deltaMinutes))}
                      </span>
                    </p>
                  </div>

                  <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
                    <Metric
                      className="h-full"
                      label="Net estimé"
                      value={formatCents(work.totals.actualNetPayableCents)}
                      hint={`Prévu ${formatCents(work.totals.plannedNetPayableCents)}`}
                      valueClassName="text-brand"
                    />
                    <Metric
                      className="h-full"
                      label="Brut estimé"
                      value={formatCents(work.totals.actualGrossCents)}
                      hint={`Prévu ${formatCents(work.totals.plannedGrossCents)}`}
                    />
                  </div>

                  <div className="mt-auto flex shrink-0 flex-col gap-2 border-t border-border-subtle/80 pt-3">
                    <p className="text-control font-medium text-fg-secondary">Pointer</p>
                    {trackableJobs.length === 0 ? (
                      <p className="text-[11px] text-fg-muted">Aucun emploi avec pointeuse activée.</p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {trackableJobs.map(({ workerName, showWorker, row }) => (
                          <li key={row.job.id}>
                            <button
                              type="button"
                              disabled={clockLoading}
                              onClick={() => void openClock(row.job)}
                              className="flex w-full cursor-pointer items-center gap-2 rounded-control border border-accent/25 bg-elevated/80 px-2.5 py-2 text-left transition-colors hover:border-accent hover:bg-accent-tint disabled:cursor-wait disabled:opacity-70"
                            >
                              <span
                                className={cn(
                                  'flex size-8 shrink-0 items-center justify-center rounded-control text-white',
                                  !row.job.color && 'bg-accent',
                                )}
                                style={row.job.color ? { backgroundColor: row.job.color } : undefined}
                                aria-hidden
                              >
                                <Icon name={row.job.icon ?? 'schedule'} className="text-icon-sm" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-control font-medium text-fg-primary">
                                  {row.job.title}
                                </span>
                                <span className="mt-0.5 block truncate text-[11px] text-fg-muted">
                                  {showWorker ? `${workerName} · ` : null}
                                  {row.job.companyName}
                                  <span className="mx-1 text-border">·</span>
                                  {formatMinutes(row.actual.workedMinutes)} ce mois
                                </span>
                              </span>
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-control bg-accent px-2.5 py-1 text-control font-semibold text-white">
                                <Icon name="touch_app" className="text-icon-sm" />
                                Pointer
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>

            <div className="grid gap-4 lg:col-span-2 lg:grid-cols-2 lg:items-start">
              {hasAccounts ? (
                <section
                  data-accent={APP_ACCENT.accounts}
                  className="rounded-panel border border-border-subtle bg-elevated p-3"
                >
                  <div className="flex items-center gap-2">
                    <Icon name="wallet" className="text-icon-sm text-fg-muted" />
                    <Typography variant="title" className="min-w-0 flex-1">
                      Soldes
                    </Typography>
                    <Link
                      to={APP_ROUTE.accounts}
                      className="text-control font-medium text-fg-secondary no-underline hover:text-fg-primary"
                    >
                      Détail
                    </Link>
                  </div>
                  <ul className="mt-3 grid list-none gap-2 p-0 sm:grid-cols-2">
                    {flatSubs.map((sub) => {
                      const status = budgetStatusLabel(forecast.bySubId[sub.id]);
                      const displayBalance = displayBalanceBySubId[sub.id] ?? sub.provisionalBalanceCents;
                      return (
                        <li key={sub.id}>
                          <Link
                            to={accountLedgerPath(sub.id)}
                            className="relative flex min-h-[5.25rem] flex-col overflow-hidden rounded-panel p-3 no-underline transition-[filter] hover:brightness-[0.98] dark:hover:brightness-110"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${sub.color} 14%, var(--color-elevated, #fff))`,
                            }}
                          >
                            <Icon
                              name={sub.icon}
                              aria-hidden
                              className="pointer-events-none absolute top-1/2 -right-5 -translate-y-1/2 text-[4.5rem]! leading-none opacity-[0.14] sm:-right-6 sm:text-[5.5rem]!"
                              style={{ color: sub.color }}
                            />
                            <div className="relative z-10 min-w-0">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <p className="truncate text-control font-semibold text-fg-primary">{sub.name}</p>
                                {status === 'over' ? (
                                  <span className="shrink-0 rounded-control-sm bg-error/15 px-1.5 py-0.5 text-[10px] font-semibold text-error">
                                    Dépassement
                                  </span>
                                ) : null}
                              </div>
                              <p className="truncate text-[11px] leading-snug text-fg-muted">{sub.accountName}</p>
                            </div>
                            <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center px-0.5 pt-1">
                              <p
                                className={cn(
                                  'text-center text-[1.05rem] font-bold leading-none tracking-tight tabular-nums sm:text-[1.15rem]',
                                  signedAmountClass(displayBalance),
                                )}
                              >
                                {formatCents(displayBalance)}
                              </p>
                            </div>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ) : null}

              <section
                className={cn(
                  'rounded-panel border border-border-subtle bg-elevated p-3',
                  !hasAccounts && 'lg:col-span-2',
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon name="event_upcoming" className="text-icon-sm text-fg-muted" />
                  <Typography variant="title" className="min-w-0 flex-1">
                    Prochaines échéances
                  </Typography>
                  <Link
                    to={APP_ROUTE.accounts}
                    className="text-control font-medium text-fg-secondary no-underline hover:text-fg-primary"
                  >
                    Voir comptes
                  </Link>
                </div>

                {deadlines.length === 0 ? (
                  <p className="mt-3 text-control text-fg-muted">Aucune échéance budget à venir ce mois-ci.</p>
                ) : (
                  <ul className="mt-3 divide-y divide-border-subtle">
                    {deadlines.map((item) => (
                      <li key={item.key}>
                        <Link
                          to={accountLedgerPath(item.subAccountId, 'budget', {
                            yearMonth,
                            lineId: item.lineId,
                          })}
                          className="flex items-center gap-3 py-2.5 no-underline transition-colors hover:bg-subtle/60"
                        >
                          <span
                            className="flex size-8 shrink-0 items-center justify-center rounded-control text-white"
                            style={{ backgroundColor: item.categoryColor }}
                            aria-hidden
                          >
                            <Icon name={item.categoryIcon} className="text-icon-sm" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-control font-medium text-fg-primary">
                              {item.categoryName}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-fg-muted">
                              {item.monthEnd ? 'Fin de mois' : `Jour ${item.day}`}
                              <span className="mx-1 text-border">·</span>
                              {item.accountName}
                              {item.subAccountName !== item.accountName ? ` · ${item.subAccountName}` : ''}
                            </span>
                          </span>
                          <span
                            className={cn(
                              'shrink-0 text-control font-semibold tabular-nums',
                              item.isExpense ? 'text-error' : 'text-success-strong',
                            )}
                          >
                            {item.isExpense ? '−' : '+'}
                            {formatCents(item.amountCents)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        )}
      </section>

      <WorkDayDialog
        isOpen={clockOpen && (clockLoading || clock !== null)}
        onClose={closeClock}
        workDate={clock?.workDate ?? today}
        planned={clock?.planned ?? emptyLane()}
        actual={clock?.actual ?? emptyLane()}
        shortcuts={clock?.shortcuts ?? []}
        timeTrackingEnabled={clock?.job.timeTrackingEnabled ?? true}
        busy={clockBusy || clockLoading}
        onPrevDay={() => void shiftClockDay(-1)}
        onNextDay={() => void shiftClockDay(1)}
        onChangePlanned={(next) => setClock((prev) => (prev ? { ...prev, planned: next, plannedDirty: true } : prev))}
        onChangeActual={(next) => setClock((prev) => (prev ? { ...prev, actual: next, actualDirty: true } : prev))}
        onCopyPlannedToActual={() =>
          setClock((prev) =>
            prev
              ? {
                  ...prev,
                  actual: {
                    ...prev.actual,
                    segments: prev.planned.segments.map((segment) => ({ ...segment })),
                    pauseMinutes: prev.planned.pauseMinutes,
                    notes: prev.planned.notes,
                  },
                  actualDirty: true,
                }
              : prev,
          )
        }
        onSave={() => void saveClock()}
        onDelete={(lane) => {
          const id = lane === 'actual' ? clock?.actual.existingId : clock?.planned.existingId;
          if (!id) return;
          setPendingDelete({ lane, id });
        }}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={pendingDelete?.lane === 'actual' ? 'Supprimer le pointage' : 'Supprimer le prévu'}
        message={
          pendingDelete?.lane === 'actual'
            ? 'Supprimer le pointage de cette journée ?'
            : 'Supprimer le planning de cette journée ?'
        }
        confirmLabel="Supprimer"
        busy={deleteBusy}
        onConfirm={() => void confirmDeleteLane()}
      />
    </div>
  );
}
