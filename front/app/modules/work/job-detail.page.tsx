import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import {
  Button,
  ChoiceCards,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FormField,
  Icon,
  IconButton,
  Tooltip,
  Typography,
} from '@components';
import {
  APP_CHROME_ROW_CLASSES,
  APP_PAGE_FILL_CLASSES,
  APP_PAGE_GUTTER_CLASSES,
  APP_PINNED_DETAIL_BODY_CLASSES,
  APP_PINNED_DETAIL_CHROME_CLASSES,
  APP_ROUTE,
  BUTTON_VARIANT,
  DIALOG_SIZE,
  FIELD_CONTROL_CLASSES,
  ICON_BUTTON_VARIANT,
  appTitle,
  currentYearMonth,
  settingsPath,
  shiftYearMonth,
} from '@constants';
import { useDocumentTitle } from '@hooks';
import {
  ApiError,
  createWorkDocument,
  deletePlanEntry,
  deleteTimeEntry,
  deleteWorkDocument,
  fetchTimeStats,
  fillPlanMonth,
  getJob,
  listPlanEntries,
  listTimeEntries,
  listTimeShortcuts,
  listWorkDocuments,
  uploadWorkDocumentFile,
  upsertPlanEntry,
  upsertTimeEntry,
  workDocumentFileUrl,
} from '@services';
import { useAuthStore } from '@store';
import type {
  TimeEntry,
  TimeShortcut,
  TimeStats,
  TimeWeekStats,
  WorkDocument,
  WorkDocumentKind,
  WorkJob,
  WorkPlanEntry,
} from '@app-types';
import { cn, formatCents, formatIsoDateFr, toastFromError, toastInfo, toastSuccess, todayIsoLocal } from '@utils';

import { WorkDayDialog, type DayLaneDraft } from './work-day-dialog.component';
import { WorkMonthCalendar } from './work-month-calendar.component';
import { TimesheetPdfDialog } from './timesheet-pdf-dialog.component';
import { DEFAULT_DAY_SHORTCUT, formatMinutes, isoWeekNumber } from './work.utils';

type TabKey = 'temps' | 'documents';
type PendingDelete =
  | { type: 'entry'; id: string; workDate: string }
  | { type: 'plan'; id: string; workDate: string }
  | { type: 'document'; id: string; label: string };

const DOC_KIND_OPTIONS = [
  { value: 'payslip' as const, label: 'Fiche de paie', icon: 'payments' },
  { value: 'contract' as const, label: 'Contrat', icon: 'description' },
  { value: 'other' as const, label: 'Autre', icon: 'folder' },
];

const DOC_KIND_LABEL: Record<WorkDocumentKind, string> = {
  contract: 'Contrat',
  payslip: 'Fiche de paie',
  other: 'Autre',
};

function isYearMonth(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}$/.test(value));
}

function isIsoDay(value: string | null): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const label = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split('-').map(Number);
  const from = `${yearMonth}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${yearMonth}-${String(last).padStart(2, '0')}`;
  return { from, to };
}

function emptyLane(): DayLaneDraft {
  return {
    segments: DEFAULT_DAY_SHORTCUT.segments.map((s) => ({ ...s })),
    pauseMinutes: DEFAULT_DAY_SHORTCUT.pauseMinutes,
    notes: '',
    existingId: null,
  };
}

function laneFromEntry(entry: TimeEntry | null): DayLaneDraft {
  if (!entry) return emptyLane();
  return {
    segments: entry.segments.map((s) => ({ start: s.start, end: s.end })),
    pauseMinutes: entry.pauseMinutes,
    notes: entry.notes ?? '',
    existingId: entry.id,
  };
}

function laneFromPlan(entry: WorkPlanEntry | null): DayLaneDraft {
  if (!entry) return emptyLane();
  return {
    segments: entry.segments.map((s) => ({ start: s.start, end: s.end })),
    pauseMinutes: entry.pauseMinutes,
    notes: entry.notes ?? '',
    existingId: entry.id,
  };
}

export function JobDetailPage() {
  const { jobId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const token = useAuthStore((state) => state.token);

  const rawTab = searchParams.get('onglet');
  const tab: TabKey =
    rawTab === 'documents' || rawTab === 'planning' || rawTab === 'pointeuse'
      ? rawTab === 'documents'
        ? 'documents'
        : 'temps'
      : 'temps';
  const yearMonth = isYearMonth(searchParams.get('mois')) ? searchParams.get('mois')! : currentYearMonth();
  const focusDayParam = isIsoDay(searchParams.get('jour')) ? searchParams.get('jour')! : null;

  const [job, setJob] = useState<WorkJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [planEntries, setPlanEntries] = useState<WorkPlanEntry[]>([]);
  const [shortcuts, setShortcuts] = useState<TimeShortcut[]>([]);
  const [stats, setStats] = useState<TimeStats | null>(null);
  const [documents, setDocuments] = useState<WorkDocument[]>([]);
  const [docFilter, setDocFilter] = useState<WorkDocumentKind | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [monthDataReadyKey, setMonthDataReadyKey] = useState<string | null>(null);
  const [pendingFocusDay, setPendingFocusDay] = useState<string | null>(focusDayParam);

  const [dayOpen, setDayOpen] = useState(false);
  const [dayDate, setDayDate] = useState(todayIsoLocal());
  const [activeLane, setActiveLane] = useState<'planned' | 'actual'>('actual');
  const [plannedDraft, setPlannedDraft] = useState<DayLaneDraft>(emptyLane);
  const [actualDraft, setActualDraft] = useState<DayLaneDraft>(emptyLane);
  const [plannedDirty, setPlannedDirty] = useState(false);
  const [actualDirty, setActualDirty] = useState(false);

  const [docDialog, setDocDialog] = useState(false);
  const [docKind, setDocKind] = useState<WorkDocumentKind>('payslip');
  const [docLabel, setDocLabel] = useState('');
  const [docYearMonth, setDocYearMonth] = useState(yearMonth);
  const [docFile, setDocFile] = useState<File | null>(null);

  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [timesheetOpen, setTimesheetOpen] = useState(false);

  const monthLabel = useMemo(() => formatMonthLabel(yearMonth), [yearMonth]);
  const range = useMemo(() => monthRange(yearMonth), [yearMonth]);

  useDocumentTitle(appTitle(job ? job.title : 'Emploi', tab === 'documents' ? 'Documents' : 'Temps'));

  const setTab = (next: TabKey) => {
    const params = new URLSearchParams();
    if (next === 'documents') params.set('onglet', 'documents');
    else params.set('mois', yearMonth);
    setSearchParams(params);
  };

  const setYearMonth = (next: string) => {
    const params = new URLSearchParams();
    if (tab === 'documents') params.set('onglet', 'documents');
    else params.set('mois', next);
    setSearchParams(params);
  };

  const loadJob = async () => {
    if (!token || !jobId) return;
    setLoading(true);
    setError(null);
    try {
      setJob(await getJob(token, jobId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Emploi introuvable.');
      setJob(null);
    } finally {
      setLoading(false);
    }
  };

  const loadMonthData = async () => {
    if (!token || !jobId) return;
    setMonthDataReadyKey(null);
    try {
      const [timeRows, planRows, sc, st] = await Promise.all([
        listTimeEntries(token, jobId, range.from, range.to),
        listPlanEntries(token, jobId, range.from, range.to),
        listTimeShortcuts(token, jobId),
        fetchTimeStats(token, jobId, range.from, range.to),
      ]);
      setEntries(timeRows);
      setPlanEntries(planRows);
      setShortcuts(sc);
      setStats(st);
      setMonthDataReadyKey(`${jobId}:${yearMonth}`);
    } catch (err) {
      toastFromError(err, 'Chargement impossible.');
    }
  };

  const loadDocuments = async () => {
    if (!token || !jobId) return;
    try {
      setDocuments(await listWorkDocuments(token, jobId));
    } catch (err) {
      toastFromError(err, 'Chargement documents impossible.');
    }
  };

  useEffect(() => {
    void loadJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, jobId]);

  useEffect(() => {
    if (!job) return;
    if (tab === 'documents') {
      void loadDocuments();
      return;
    }
    void loadMonthData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, job?.id, yearMonth]);

  useEffect(() => {
    if (!focusDayParam) return;
    setPendingFocusDay(focusDayParam);
    const params = new URLSearchParams(searchParams);
    params.delete('jour');
    setSearchParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDayParam]);

  useEffect(() => {
    if (!pendingFocusDay || !job || tab === 'documents') return;
    const dayMonth = pendingFocusDay.slice(0, 7);
    if (dayMonth !== yearMonth) {
      setYearMonth(dayMonth);
      return;
    }
    if (monthDataReadyKey !== `${jobId}:${yearMonth}`) return;
    openDay(pendingFocusDay, job.timeTrackingEnabled ? 'actual' : 'planned');
    setPendingFocusDay(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocusDay, job, tab, yearMonth, monthDataReadyKey, jobId]);

  const openDay = (workDate: string, preferLane?: 'planned' | 'actual') => {
    const plan = planEntries.find((p) => p.workDate === workDate) ?? null;
    const entry = entries.find((e) => e.workDate === workDate) ?? null;
    setPlannedDraft(laneFromPlan(plan));
    setActualDraft(laneFromEntry(entry));
    setPlannedDirty(false);
    setActualDirty(false);
    setDayDate(workDate);
    setActiveLane(preferLane ?? (job?.timeTrackingEnabled === false ? 'planned' : 'actual'));
    setDayOpen(true);
  };

  const copyPlannedToActual = () => {
    setActualDraft((prev) => ({
      ...prev,
      segments: plannedDraft.segments.map((s) => ({ ...s })),
      pauseMinutes: plannedDraft.pauseMinutes,
      notes: plannedDraft.notes,
    }));
    setActualDirty(true);
    setActiveLane('actual');
  };

  const closeDay = () => setDayOpen(false);

  const saveDayLane = async () => {
    if (!token || !jobId || !job) return;
    setBusy(true);
    let saved = false;
    try {
      const tracking = job.timeTrackingEnabled;
      const nothingDirty = !plannedDirty && !actualDirty;
      const shouldSavePlanned = !tracking || plannedDirty || (nothingDirty && activeLane === 'planned');
      const shouldSaveActual = tracking && (actualDirty || (nothingDirty && activeLane === 'actual'));

      if (shouldSavePlanned) {
        await upsertPlanEntry(token, jobId, {
          workDate: dayDate,
          segments: plannedDraft.segments,
          pauseMinutes: plannedDraft.pauseMinutes,
          notes: plannedDraft.notes || null,
        });
      }
      if (shouldSaveActual) {
        await upsertTimeEntry(token, jobId, {
          workDate: dayDate,
          segments: actualDraft.segments,
          pauseMinutes: actualDraft.pauseMinutes,
          notes: actualDraft.notes || null,
        });
      }
      if (shouldSavePlanned && shouldSaveActual) toastSuccess('Journée enregistrée.');
      else if (shouldSavePlanned) toastSuccess('Planning enregistré.');
      else toastSuccess('Pointage enregistré.');
      // Fermer avant le reload : évite un dialog coincé si le rechargement traîne (PWA mobile).
      closeDay();
      saved = true;
    } catch (err) {
      toastFromError(err, 'Enregistrement impossible.');
    } finally {
      setBusy(false);
    }
    if (saved) await loadMonthData();
  };

  const confirmDelete = async () => {
    if (!token || !pendingDelete) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.type === 'entry') {
        await deleteTimeEntry(token, pendingDelete.id);
        toastSuccess('Pointage supprimé.');
        closeDay();
        await loadMonthData();
      } else if (pendingDelete.type === 'plan') {
        await deletePlanEntry(token, pendingDelete.id);
        toastSuccess('Jour retiré du planning.');
        closeDay();
        await loadMonthData();
      } else {
        await deleteWorkDocument(token, pendingDelete.id);
        toastSuccess('Document supprimé.');
        await loadDocuments();
      }
      setPendingDelete(null);
    } catch (err) {
      toastFromError(err, 'Suppression impossible.');
    } finally {
      setDeleteBusy(false);
    }
  };

  const fillMonth = async () => {
    if (!token || !jobId || !job) return;
    if (!job.weekTemplate) {
      toastInfo('Définissez d’abord une semaine type dans Paramètres → Travail.');
      return;
    }
    setBusy(true);
    try {
      const result = await fillPlanMonth(token, jobId, {
        yearMonth,
        overwrite: false,
      });
      toastSuccess(`Mois rempli : ${result.created} créés, ${result.skipped} ignorés.`);
      await loadMonthData();
    } catch (err) {
      toastFromError(err, 'Remplissage impossible.');
    } finally {
      setBusy(false);
    }
  };

  const openDocDialog = () => {
    setDocKind('payslip');
    setDocLabel('');
    setDocYearMonth(yearMonth);
    setDocFile(null);
    setDocDialog(true);
  };

  const saveDocument = async () => {
    if (!token || !jobId) return;
    setBusy(true);
    try {
      const doc = await createWorkDocument(token, jobId, {
        kind: docKind,
        label: docLabel.trim(),
        yearMonth: docKind === 'payslip' ? docYearMonth : null,
      });
      if (docFile) await uploadWorkDocumentFile(token, doc.id, docFile);
      toastSuccess('Document ajouté.');
      setDocDialog(false);
      await loadDocuments();
    } catch (err) {
      toastFromError(err, 'Ajout document impossible.');
    } finally {
      setBusy(false);
    }
  };

  const downloadDocument = async (doc: WorkDocument) => {
    if (!token || !doc.fileUrl) return;
    try {
      const response = await fetch(workDocumentFileUrl(doc.fileUrl), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('download');
      const blob = await response.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch {
      toastFromError(new Error('Téléchargement impossible.'), 'Téléchargement impossible.');
    }
  };

  if (loading) {
    return (
      <div className={cn(APP_PAGE_FILL_CLASSES, APP_PAGE_GUTTER_CLASSES)}>
        <p className="text-body text-fg-muted">Chargement…</p>
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className={cn(APP_PAGE_FILL_CLASSES, APP_PAGE_GUTTER_CLASSES)}>
        <EmptyState
          fullHeight
          icon="work"
          title="Emploi introuvable"
          message={error ?? 'Cet emploi n’existe pas.'}
          action={
            <Link to={APP_ROUTE.work} className="text-accent underline">
              Retour au travail
            </Link>
          }
        />
      </div>
    );
  }

  const planned = stats?.planned;
  const actual = stats?.actual ?? stats?.period;
  const calendarDays = stats?.days ?? [];
  const weekRows = stats?.weeks ?? [];
  const today = todayIsoLocal();
  const filteredDocs = docFilter === 'all' ? documents : documents.filter((d) => d.kind === docFilter);
  const delta = (actual?.workedMinutes ?? 0) - (planned?.workedMinutes ?? 0);
  const contractHoursLabel = formatMinutes(job.contractWeeklyMinutes);

  return (
    <div className={`${APP_PAGE_FILL_CLASSES} overflow-hidden`}>
      <div className={APP_PINNED_DETAIL_CHROME_CLASSES}>
        <div className={APP_CHROME_ROW_CLASSES}>
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to={APP_ROUTE.work}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-fg-secondary hover:bg-subtle hover:text-fg-primary"
              aria-label="Retour au travail"
            >
              <Icon name="arrow_back" className="text-icon-sm" />
            </Link>
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent text-white sm:size-10"
              style={job.color ? { backgroundColor: job.color } : undefined}
            >
              <Icon name={job.icon ?? 'work'} className="text-icon-sm" />
            </span>
            <div className="min-w-0 flex-1">
              <Typography variant="title" as="h1" className="truncate text-fg-primary">
                {job.title}
              </Typography>
              <p className="truncate text-control text-fg-secondary">
                {job.companyName}
                <span className="text-fg-muted"> · {job.workerFullName}</span>
              </p>
            </div>
          </div>

          <div className="flex w-full justify-center md:w-auto md:px-1">
            {tab === 'temps' ? (
              <div className="flex items-center gap-0.5">
                <IconButton
                  variant={ICON_BUTTON_VARIANT.ghost}
                  icon="chevron_left"
                  aria-label="Mois précédent"
                  onClick={() => setYearMonth(shiftYearMonth(yearMonth, -1))}
                />
                <Typography
                  variant="body"
                  weight="semibold"
                  className="min-w-0 max-w-[9.5rem] truncate px-1 text-center tabular-nums sm:min-w-[8.5rem] sm:max-w-none"
                >
                  {monthLabel}
                </Typography>
                <IconButton
                  variant={ICON_BUTTON_VARIANT.ghost}
                  icon="chevron_right"
                  aria-label="Mois suivant"
                  onClick={() => setYearMonth(shiftYearMonth(yearMonth, 1))}
                />
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
            <div
              className="inline-flex rounded-control border border-border-subtle bg-subtle p-0.5"
              role="group"
              aria-label="Vue de l’emploi"
            >
              <button
                type="button"
                onClick={() => setTab('temps')}
                className={cn(
                  'inline-flex h-9 cursor-pointer items-center gap-1 rounded-control px-2 text-control font-medium transition-colors',
                  tab === 'temps' ? 'bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
                )}
              >
                <Icon name="calendar_month" className="text-icon-sm" />
                <span className="hidden sm:inline">Temps</span>
              </button>
              <button
                type="button"
                onClick={() => setTab('documents')}
                className={cn(
                  'inline-flex h-9 cursor-pointer items-center gap-1 rounded-control px-2 text-control font-medium transition-colors',
                  tab === 'documents' ? 'bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
                )}
              >
                <Icon name="folder" className="text-icon-sm" />
                <span className="hidden sm:inline">Documents</span>
              </button>
            </div>

            {tab === 'temps' ? (
              <>
                <Tooltip content="Exporter en PDF">
                  <IconButton
                    variant={ICON_BUTTON_VARIANT.ghost}
                    icon="picture_as_pdf"
                    aria-label="Exporter en PDF"
                    onClick={() => setTimesheetOpen(true)}
                  />
                </Tooltip>
                <Tooltip content="Aujourd’hui">
                  <IconButton
                    variant={ICON_BUTTON_VARIANT.ghost}
                    icon="today"
                    aria-label="Aujourd’hui"
                    onClick={() => {
                      const ym = today.slice(0, 7);
                      if (ym !== yearMonth) setYearMonth(ym);
                      openDay(today);
                    }}
                  />
                </Tooltip>
                <Button
                  type="button"
                  variant={BUTTON_VARIANT.successOutline}
                  fullWidth={false}
                  className="h-9 w-auto shrink-0 px-2.5 text-control"
                  disabled={busy}
                  onClick={() => void fillMonth()}
                >
                  <Icon name="auto_fix_high" className="text-icon-sm" />
                  <span className="hidden sm:inline">Remplir</span>
                </Button>
              </>
            ) : (
              <Button
                type="button"
                fullWidth={false}
                className="h-9 w-auto shrink-0 px-2.5 text-control"
                onClick={openDocDialog}
              >
                <Icon name="add" className="text-icon-sm" />
                <span className="hidden sm:inline">Document</span>
              </Button>
            )}

            <Link
              to={settingsPath('travail')}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-control text-fg-secondary hover:bg-subtle hover:text-fg-primary"
              aria-label="Paramètres travail"
            >
              <Icon name="settings" className="text-icon-sm" />
            </Link>
          </div>
        </div>
      </div>

      <div className={cn(APP_PINNED_DETAIL_BODY_CLASSES, APP_PAGE_GUTTER_CLASSES, 'overflow-y-auto')} data-app-scroll>
        {tab === 'temps' ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <PaySummaryCard
                title="Prévu"
                icon="calendar_month"
                minutes={planned?.workedMinutes ?? 0}
                grossCents={planned?.estimatedGrossCents ?? 0}
                netCents={planned?.estimatedNetPayableCents ?? 0}
              />
              <PaySummaryCard
                title="Réel"
                icon="schedule"
                minutes={actual?.workedMinutes ?? 0}
                grossCents={actual?.estimatedGrossCents ?? 0}
                netCents={actual?.estimatedNetPayableCents ?? 0}
                emphasize
                footnote={
                  <>
                    Écart heures{' '}
                    <span className={cn('font-semibold', delta < 0 ? 'text-error' : 'text-success-strong')}>
                      {delta >= 0 ? '+' : '−'}
                      {formatMinutes(Math.abs(delta))}
                    </span>
                  </>
                }
              />
            </div>

            <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]">
              <WorkMonthCalendar
                yearMonth={yearMonth}
                days={calendarDays}
                weekStartsOn={job.weekStartsOn}
                workDaysMask={job.workDaysMask}
                selectedDate={dayOpen ? dayDate : null}
                onSelectDay={(workDate) => openDay(workDate)}
              />

              {weekRows.length > 0 ? (
                <section className="flex min-w-0 flex-col gap-1.5 lg:sticky lg:top-0">
                  <div className="px-0.5">
                    <p className="text-control font-semibold">Semaines</p>
                    <p className="text-[11px] text-fg-muted">
                      Heures supp. vs 35h00 et vs contrat ({contractHoursLabel})
                    </p>
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {weekRows.map((week) => (
                      <WeekStatsRow key={`${week.from}-${week.to}`} week={week} />
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div
              className="flex max-w-full flex-wrap self-start rounded-control border border-border-subtle bg-subtle p-0.5"
              role="group"
              aria-label="Filtrer les documents"
            >
              {(
                [
                  { key: 'all' as const, label: 'Tous' },
                  { key: 'payslip' as const, label: 'Paie' },
                  { key: 'contract' as const, label: 'Contrats' },
                  { key: 'other' as const, label: 'Autres' },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setDocFilter(item.key)}
                  className={cn(
                    'inline-flex h-9 cursor-pointer items-center rounded-control px-3 text-control font-medium transition-colors',
                    docFilter === item.key ? 'bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {filteredDocs.length === 0 ? (
              <EmptyState
                icon="folder"
                title="Aucun document"
                message={
                  docFilter === 'all'
                    ? 'Ajoutez contrats, fiches de paie ou autres pièces.'
                    : `Aucun document de type « ${DOC_KIND_LABEL[docFilter]} ».`
                }
                action={
                  <Button type="button" fullWidth={false} className="w-auto px-4" onClick={openDocDialog}>
                    <Icon name="add" className="text-icon-sm" />
                    Ajouter
                  </Button>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {filteredDocs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center gap-3 rounded-control border border-border-subtle bg-elevated px-3 py-2.5"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-press">
                      <Icon
                        name={doc.kind === 'payslip' ? 'payments' : doc.kind === 'contract' ? 'description' : 'folder'}
                        className="text-icon-sm"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-fg-primary">{doc.label}</p>
                      <p className="text-control text-fg-muted">
                        {DOC_KIND_LABEL[doc.kind]}
                        {doc.yearMonth ? ` · ${formatMonthLabel(doc.yearMonth)}` : ''}
                        {doc.hasFile ? '' : ' · sans fichier'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5">
                      {doc.hasFile && doc.fileUrl ? (
                        <IconButton
                          variant={ICON_BUTTON_VARIANT.ghost}
                          icon="download"
                          aria-label="Télécharger"
                          onClick={() => void downloadDocument(doc)}
                        />
                      ) : null}
                      <IconButton
                        variant={ICON_BUTTON_VARIANT.ghost}
                        icon="delete"
                        aria-label="Supprimer"
                        onClick={() => setPendingDelete({ type: 'document', id: doc.id, label: doc.label })}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <WorkDayDialog
        isOpen={dayOpen}
        onClose={closeDay}
        workDate={dayDate}
        planned={plannedDraft}
        actual={actualDraft}
        shortcuts={shortcuts}
        timeTrackingEnabled={job.timeTrackingEnabled}
        busy={busy}
        onChangePlanned={(next) => {
          setPlannedDraft(next);
          setPlannedDirty(true);
        }}
        onChangeActual={(next) => {
          setActualDraft(next);
          setActualDirty(true);
        }}
        onCopyPlannedToActual={copyPlannedToActual}
        onSave={() => void saveDayLane()}
        onDelete={(lane) => {
          if (lane === 'planned' && plannedDraft.existingId) {
            setPendingDelete({ type: 'plan', id: plannedDraft.existingId, workDate: dayDate });
          } else if (lane === 'actual' && actualDraft.existingId) {
            setPendingDelete({ type: 'entry', id: actualDraft.existingId, workDate: dayDate });
          }
        }}
      />

      <Dialog
        isOpen={docDialog}
        onClose={() => setDocDialog(false)}
        title="Nouveau document"
        icon="upload_file"
        size={DIALOG_SIZE.large}
      >
        <div className="mt-2 flex flex-col gap-4">
          <ChoiceCards label="Type de document" options={DOC_KIND_OPTIONS} value={docKind} onChange={setDocKind} />
          <FormField label="Libellé" htmlFor="doc-label">
            <input
              id="doc-label"
              className={FIELD_CONTROL_CLASSES}
              value={docLabel}
              onChange={(e) => setDocLabel(e.target.value)}
              placeholder={
                docKind === 'payslip'
                  ? `Fiche de paie ${formatMonthLabel(docYearMonth)}`
                  : docKind === 'contract'
                    ? 'Contrat de travail'
                    : 'Document'
              }
            />
          </FormField>
          {docKind === 'payslip' ? (
            <FormField label="Mois" htmlFor="doc-ym">
              <input
                id="doc-ym"
                type="month"
                className={FIELD_CONTROL_CLASSES}
                value={docYearMonth}
                onChange={(e) => setDocYearMonth(e.target.value)}
              />
            </FormField>
          ) : null}
          <FormField label="Fichier" htmlFor="doc-file" hint="PDF ou image (optionnel)">
            <input
              id="doc-file"
              type="file"
              accept="image/*,application/pdf"
              className="block w-full text-control text-fg-secondary file:me-3 file:rounded-control file:border-0 file:bg-accent-tint file:px-3 file:py-2 file:text-control file:font-medium file:text-accent-press"
              onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
            />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              variant={BUTTON_VARIANT.dangerOutline}
              fullWidth={false}
              className="w-auto px-3"
              disabled={busy}
              onClick={() => setDocDialog(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant={BUTTON_VARIANT.success}
              fullWidth={false}
              className="w-auto px-4"
              loading={busy}
              disabled={!docLabel.trim()}
              onClick={() => void saveDocument()}
            >
              Enregistrer
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        isOpen={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title={
          pendingDelete?.type === 'document'
            ? 'Supprimer le document'
            : pendingDelete?.type === 'plan'
              ? 'Retirer du planning'
              : 'Supprimer le pointage'
        }
        message={
          pendingDelete?.type === 'document'
            ? `Supprimer « ${pendingDelete.label} » ? Cette action est définitive.`
            : pendingDelete
              ? `Confirmer pour le ${formatIsoDateFr(pendingDelete.workDate, { weekday: 'long' })} ?`
              : ''
        }
        confirmLabel="Supprimer"
        confirmVariant={BUTTON_VARIANT.danger}
        busy={deleteBusy}
      />

      {token ? (
        <TimesheetPdfDialog
          isOpen={timesheetOpen}
          onClose={() => setTimesheetOpen(false)}
          token={token}
          jobId={jobId}
          yearMonth={yearMonth}
          monthLabel={monthLabel}
        />
      ) : null}
    </div>
  );
}

function PaySummaryCard({
  title,
  icon,
  minutes,
  grossCents,
  netCents,
  emphasize,
  footnote,
}: {
  title: string;
  icon: string;
  minutes: number;
  grossCents: number;
  netCents: number;
  emphasize?: boolean;
  footnote?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-control border px-3 py-3',
        emphasize ? 'border-accent/30 bg-accent-tint/50' : 'border-border-subtle bg-elevated',
      )}
    >
      <div className="flex items-center gap-1.5 text-control font-semibold text-fg-primary">
        <Icon name={icon} className="text-icon-sm text-fg-muted" />
        {title}
      </div>
      <p className={cn('mt-1 text-[1.35rem] font-bold tabular-nums', emphasize ? 'text-brand' : 'text-fg-primary')}>
        {formatMinutes(minutes)}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border-subtle/80 pt-2">
        <div>
          <p className="text-[11px] text-fg-muted">Brut estimé</p>
          <p className="font-semibold tabular-nums">{formatCents(grossCents)}</p>
        </div>
        <div>
          <p className="text-[11px] text-fg-muted">Net estimé</p>
          <p className={cn('font-semibold tabular-nums', emphasize && 'text-brand')}>{formatCents(netCents)}</p>
        </div>
      </div>
      {footnote ? <p className="mt-2 text-[11px] text-fg-muted">{footnote}</p> : null}
    </div>
  );
}

function WeekStatsRow({ week }: { week: TimeWeekStats }) {
  const weekNo = isoWeekNumber(week.from);
  const hasActivity = week.actual.workedMinutes > 0 || week.planned.workedMinutes > 0;

  return (
    <li
      className={cn(
        'grid grid-cols-[2.25rem_minmax(0,1fr)] gap-2 rounded-control border border-border-subtle px-2 py-2',
        hasActivity ? 'bg-elevated' : 'bg-subtle/40',
      )}
    >
      <div
        className="flex flex-col items-center justify-center self-stretch rounded-control-sm bg-subtle"
        title={`Semaine ${weekNo}`}
      >
        <span className="text-[9px] leading-none text-fg-muted">Sem.</span>
        <span className="text-control font-semibold tabular-nums text-fg-primary">{weekNo}</span>
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-[11px] tabular-nums text-fg-secondary">
          <span className="text-fg-muted">Prévu</span> {formatMinutes(week.planned.workedMinutes)}
          <span className="mx-1.5 text-border">·</span>
          <span className="text-fg-muted">Réel</span>{' '}
          <span className="font-medium text-fg-primary">{formatMinutes(week.actual.workedMinutes)}</span>
        </p>
        <p className="text-[11px] tabular-nums text-fg-muted">
          Réel — net <span className="font-medium text-brand">{formatCents(week.actual.estimatedNetPayableCents)}</span>
          <span className="mx-1.5 text-border">·</span>
          brut {formatCents(week.actual.estimatedGrossCents)}
        </p>
        <p className="text-[11px] tabular-nums text-fg-muted">
          Prévu — net {formatCents(week.planned.estimatedNetPayableCents)}
          <span className="mx-1.5 text-border">·</span>
          brut {formatCents(week.planned.estimatedGrossCents)}
        </p>
        <p className="text-[11px] tabular-nums text-fg-muted">
          Supp. 35h {formatMinutes(week.actualOvertimeVsLegalMinutes)}
          <span className="mx-1.5 text-border">·</span>
          supp. contrat {formatMinutes(week.actualOvertimeVsContractMinutes)}
        </p>
      </div>
    </li>
  );
}
