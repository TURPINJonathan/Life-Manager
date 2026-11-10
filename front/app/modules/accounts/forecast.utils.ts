import { currentYearMonth, shiftYearMonth } from '@constants';
import type { CategoryKind, ForecastStats, ForecastStatsCategory, ForecastTimelinePoint, SubAccount } from '@app-types';

import { compareForecastProgress, isExpenseStatsRow } from './forecast-budget.utils';

export type FlatSubAccount = SubAccount & { accountName: string };

export type AggregatedStatsCategory = {
  key: string;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  categoryKind: CategoryKind;
  flow: 'credit' | 'debit' | null;
  scheduledDays: number[];
  plannedAmountCents: number;
  plannedSignedCents: number;
  actualAmountCents: number;
  actualSignedCents: number;
  remainingCents: number;
  consumptionPercent: number;
  overBudget: boolean;
  lineCount: number;
};

export type CategoryBarItem = {
  key: string;
  name: string;
  color: string;
  plannedCents: number;
  actualCents: number;
  isExpense: boolean;
};

/** Agrège les lignes stats (plusieurs échéances / sous-comptes) par catégorie+flux. */
export function aggregateStatsCategories(rows: ForecastStatsCategory[]): AggregatedStatsCategory[] {
  const map = new Map<string, AggregatedStatsCategory>();

  for (const row of rows) {
    const key = `${row.categoryId}:${row.flow ?? 'auto'}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        categoryIcon: row.categoryIcon,
        categoryColor: row.categoryColor,
        categoryKind: row.categoryKind,
        flow: row.flow,
        scheduledDays: row.scheduledDay !== null ? [row.scheduledDay] : [],
        plannedAmountCents: row.plannedAmountCents,
        plannedSignedCents: row.plannedSignedCents,
        actualAmountCents: row.actualAmountCents,
        actualSignedCents: row.actualSignedCents,
        remainingCents: row.remainingCents,
        consumptionPercent: 0,
        overBudget: false,
        lineCount: 1,
      });
      continue;
    }

    existing.plannedAmountCents += row.plannedAmountCents;
    existing.plannedSignedCents += row.plannedSignedCents;
    existing.actualAmountCents += row.actualAmountCents;
    existing.actualSignedCents += row.actualSignedCents;
    existing.remainingCents += row.remainingCents;
    existing.lineCount += 1;
    if (row.scheduledDay !== null && !existing.scheduledDays.includes(row.scheduledDay)) {
      existing.scheduledDays.push(row.scheduledDay);
    }
  }

  return [...map.values()]
    .map((row) => {
      const consumptionPercent =
        row.plannedAmountCents > 0
          ? Math.round((row.actualAmountCents / row.plannedAmountCents) * 100)
          : row.actualAmountCents > 0
            ? 100
            : 0;
      const isExpense = isExpenseStatsRow(row);
      return {
        ...row,
        scheduledDays: [...row.scheduledDays].sort((a, b) => a - b),
        consumptionPercent,
        overBudget: isExpense && row.actualAmountCents > row.plannedAmountCents,
      };
    })
    .sort((a, b) => {
      const aExpense = isExpenseStatsRow(a);
      const bExpense = isExpenseStatsRow(b);
      if (aExpense !== bExpense) {
        return aExpense ? -1 : 1;
      }
      return compareForecastProgress(a, b);
    });
}

export function toCategoryBars(rows: AggregatedStatsCategory[]): CategoryBarItem[] {
  // Les catégories 100 % flexibles (sans jour) sont lissées dans la courbe, pas en barres.
  return rows
    .filter((row) => row.scheduledDays.length > 0)
    .map((row) => ({
      key: row.key,
      name: row.categoryName,
      color: row.categoryColor,
      plannedCents: row.plannedAmountCents,
      actualCents: row.actualAmountCents,
      isExpense: isExpenseStatsRow(row),
    }));
}

/** Totaux catégories combinés pour le dashboard (tous sous-comptes). */
export function aggregateDashboardCategoryBars(statsBySubId: Record<string, ForecastStats | null>): CategoryBarItem[] {
  const rows = Object.values(statsBySubId).flatMap((stats) => stats?.categories ?? []);
  return toCategoryBars(aggregateStatsCategories(rows));
}

export type SubForecastSummary = {
  hasForecast: boolean;
  overBudget: boolean;
  projectedRealisticCents: number;
  projectedBudgetCents: number;
  currentCents: number;
};

export type DashboardForecastAggregate = {
  yearMonth: string;
  balances: {
    projectedRealisticCents: number;
    projectedBudgetCents: number;
  };
  totals: {
    plannedIncomeCents: number;
    plannedExpenseCents: number;
    actualIncomeCents: number;
    actualExpenseCents: number;
  };
  unbudgetedExpenseCents: number;
  unbudgetedIncomeCents: number;
  withBudgetCount: number;
  totalSubsCount: number;
  missingBudget: FlatSubAccount[];
  overBudgetSubs: FlatSubAccount[];
  bySubId: Record<string, SubForecastSummary>;
  meta: ForecastStats['meta'] | null;
};

export type DashboardTimelineAggregate = {
  points: ForecastTimelinePoint[];
  daysElapsed: number;
  previousActualPoints: Array<{ day: number; balanceCents: number }>;
};

export function formatMonthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const label = new Date(year, month - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Libellé court pour une borne de période (ex. « oct. 2025 »). */
export function formatMonthShortLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }).replace('.', '');
}

/** Libellé chrome pour la période annuelle (année civile ou 12 mois). */
export function formatYearPeriodLabel(anchor: string, span: 'calendar' | 'rolling'): string {
  if (span === 'calendar') {
    return `Année ${anchor.slice(0, 4)}`;
  }
  const [y, m] = anchor.split('-').map(Number);
  const start = new Date(y, m - 1 - 11, 1);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
  return `${formatMonthShortLabel(from)} — ${formatMonthShortLabel(anchor)}`;
}

/**
 * Solde à afficher pour le mois sélectionné (fin de mois / actuel provisoire / projection).
 * `liveBalanceCents` = solde provisoire du sous-compte (opérations pointées + en attente).
 */
export function monthDisplayBalanceCents(stats: ForecastStats | null | undefined, liveBalanceCents: number): number {
  if (!stats) return liveBalanceCents;
  if (stats.meta.isPastMonth) return stats.balances.endOfMonthActualCents;
  if (stats.meta.isFutureMonth) return stats.balances.projectedRealisticCents;
  return liveBalanceCents;
}

/**
 * Recalcule soldes + timeline à partir d’un nouveau solde d’ouverture (what-if front-only).
 * Ne touche pas au solde pointé live ni à l’écart plan/réalisé.
 */
export function rebaseForecastStats(stats: ForecastStats, newOpeningCents: number): ForecastStats {
  const delta = newOpeningCents - stats.balances.openingCents;
  if (delta === 0) return stats;

  return {
    ...stats,
    balances: {
      ...stats.balances,
      openingCents: newOpeningCents,
      endOfMonthActualCents: stats.balances.endOfMonthActualCents + delta,
      projectedBudgetCents: stats.balances.projectedBudgetCents + delta,
      projectedRealisticCents: stats.balances.projectedRealisticCents + delta,
    },
    timeline: stats.timeline.map((point) => ({
      ...point,
      budgetBalanceCents: point.budgetBalanceCents + delta,
      realisticBalanceCents: point.realisticBalanceCents + delta,
      actualBalanceCents: point.actualBalanceCents == null ? null : point.actualBalanceCents + delta,
    })),
  };
}

/**
 * Affiche soldes + remplissage des lignes à un jour donné (what-if front-only).
 * — Échéance datée : 100 % si due, sinon 0 %.
 * — Flexible : lissé linéairement (jour / jours du mois).
 * Ajuste aussi `daysElapsed` pour le curseur du graphique.
 */
export function focusForecastStatsOnDay(stats: ForecastStats, day: number): ForecastStats {
  const daysInMonth = stats.meta.daysInMonth;
  const clamped = Math.min(Math.max(day, 1), daysInMonth);
  const point = stats.timeline.find((row) => row.day === clamped);
  if (!point) return stats;

  const categories = stats.categories.map((row) => {
    if (row.scheduledDay === null) {
      const ratio = clamped / daysInMonth;
      const actualAmountCents = Math.round(row.plannedAmountCents * ratio);
      const actualSignedCents = Math.round(row.plannedSignedCents * ratio);
      const remainingCents = Math.max(0, row.plannedAmountCents - actualAmountCents);
      const consumptionPercent =
        row.plannedAmountCents > 0 ? Math.round((actualAmountCents / row.plannedAmountCents) * 100) : 0;
      return {
        ...row,
        actualAmountCents,
        actualSignedCents,
        remainingCents,
        consumptionPercent,
        overBudget: false,
      };
    }

    const dueDay = Math.min(Math.max(row.scheduledDay, 1), daysInMonth);
    if (dueDay > clamped) {
      return {
        ...row,
        actualAmountCents: 0,
        actualSignedCents: 0,
        remainingCents: row.plannedAmountCents,
        consumptionPercent: 0,
        overBudget: false,
      };
    }

    return {
      ...row,
      actualAmountCents: row.plannedAmountCents,
      actualSignedCents: row.plannedSignedCents,
      remainingCents: 0,
      consumptionPercent: row.plannedAmountCents > 0 ? 100 : 0,
      overBudget: false,
    };
  });

  let actualIncomeCents = 0;
  let actualExpenseCents = 0;
  for (const row of categories) {
    if (isExpenseStatsRow(row)) {
      actualExpenseCents += row.actualAmountCents;
    } else {
      actualIncomeCents += row.actualAmountCents;
    }
  }
  const actualNetCents = actualIncomeCents - actualExpenseCents;

  return {
    ...stats,
    balances: {
      ...stats.balances,
      // Timeline API : flexibles déjà lissés jour par jour.
      projectedBudgetCents: point.budgetBalanceCents,
      projectedRealisticCents: point.realisticBalanceCents,
      endOfMonthActualCents: stats.balances.openingCents + actualNetCents,
      varianceBudgetVsActualNetCents: stats.totals.plannedNetCents - actualNetCents,
    },
    totals: {
      ...stats.totals,
      actualIncomeCents,
      actualExpenseCents,
      actualNetCents,
    },
    categories,
    meta: {
      ...stats.meta,
      daysElapsed: clamped,
      daysRemaining: Math.max(0, daysInMonth - clamped),
    },
  };
}

/** Mois strictement après `fromYearMonth` et strictement avant `toYearMonth`. */
export function yearMonthsStrictlyBetween(fromYearMonth: string, toYearMonth: string): string[] {
  const months: string[] = [];
  let cursor = shiftYearMonth(fromYearMonth, 1);
  while (cursor < toYearMonth) {
    months.push(cursor);
    cursor = shiftYearMonth(cursor, 1);
  }
  return months;
}

export function budgetStatusLabel(summary: SubForecastSummary | undefined): 'ok' | 'over' | 'missing' {
  if (!summary || !summary.hasForecast) {
    return 'missing';
  }
  return summary.overBudget ? 'over' : 'ok';
}

function pickTimelinePoint(
  timeline: ForecastTimelinePoint[],
  day: number,
  index: number,
): ForecastTimelinePoint | null {
  return timeline.find((point) => point.day === day) ?? timeline[index] ?? null;
}

/** Agrège les timelines des sous-comptes (soldes additionnés jour par jour). */
export function aggregateDashboardTimeline(
  subs: FlatSubAccount[],
  statsBySubId: Record<string, ForecastStats | null>,
  previousStatsBySubId: Record<string, ForecastStats | null> = {},
): DashboardTimelineAggregate {
  const withTimeline = subs
    .map((sub) => ({ sub, stats: statsBySubId[sub.id] ?? null }))
    .filter((row): row is { sub: FlatSubAccount; stats: ForecastStats } =>
      Boolean(row.stats?.timeline && row.stats.timeline.length > 0),
    );

  if (withTimeline.length === 0) {
    return { points: [], daysElapsed: 0, previousActualPoints: [] };
  }

  const daysElapsed = Math.max(...withTimeline.map((row) => row.stats.meta.daysElapsed), 0);
  const template = withTimeline.reduce((best, row) =>
    row.stats.timeline.length > best.stats.timeline.length ? row : best,
  ).stats.timeline;

  const staticBalanceCents = subs
    .filter((sub) => !(statsBySubId[sub.id]?.timeline && statsBySubId[sub.id]!.timeline.length > 0))
    .reduce((sum, sub) => sum + sub.balanceCents, 0);

  const points: ForecastTimelinePoint[] = template.map((templatePoint, index) => {
    let budgetBalanceCents = staticBalanceCents;
    let realisticBalanceCents = staticBalanceCents;
    let actualBalanceCents: number | null = templatePoint.day <= daysElapsed ? staticBalanceCents : null;
    const events: ForecastTimelinePoint['events'] = [];

    for (const { stats } of withTimeline) {
      const point = pickTimelinePoint(stats.timeline, templatePoint.day, index);
      if (!point) continue;
      budgetBalanceCents += point.budgetBalanceCents;
      realisticBalanceCents += point.realisticBalanceCents;
      if (actualBalanceCents !== null) {
        actualBalanceCents += point.actualBalanceCents ?? point.realisticBalanceCents;
      }
      for (const event of point.events) {
        events.push(event);
      }
    }

    return {
      day: templatePoint.day,
      date: templatePoint.date,
      budgetBalanceCents,
      realisticBalanceCents,
      actualBalanceCents,
      events: events.slice(0, 8),
    };
  });

  const previousWithTimeline = subs
    .map((sub) => previousStatsBySubId[sub.id] ?? null)
    .filter((stats): stats is ForecastStats => Boolean(stats?.timeline && stats.timeline.length > 0));

  const previousDaySet = new Set<number>();
  for (const stats of previousWithTimeline) {
    for (const point of stats.timeline) {
      previousDaySet.add(point.day);
    }
  }

  // Uniquement les sous-comptes qui ont une timeline M−1 (pas le solde actuel).
  const previousActualPoints = [...previousDaySet]
    .sort((a, b) => a - b)
    .map((day) => {
      let balanceCents = 0;
      for (const stats of previousWithTimeline) {
        const point = stats.timeline.find((row) => row.day === day);
        if (!point) continue;
        balanceCents += point.actualBalanceCents ?? point.realisticBalanceCents;
      }
      return { day, balanceCents };
    });

  return { points, daysElapsed, previousActualPoints };
}

export type UpcomingDeadline = {
  key: string;
  lineId: string;
  day: number;
  /** Jour non fixé : l’échéance est portée en fin de mois. */
  monthEnd: boolean;
  categoryName: string;
  categoryColor: string;
  categoryIcon: string;
  amountCents: number;
  actualAmountCents: number;
  isExpense: boolean;
  accountId: string;
  accountName: string;
  subAccountId: string;
  subAccountName: string;
};

function deadlineFromRow(
  sub: FlatSubAccount,
  row: ForecastStatsCategory,
  daysInMonth: number,
): UpcomingDeadline | null {
  // Date flexible = pas d’échéance calendaire.
  if (row.scheduledDay === null) return null;

  const day = Math.min(Math.max(row.scheduledDay, 1), daysInMonth);
  const isExpense = row.categoryKind === 'expense' || (row.categoryKind === 'both' && row.flow === 'debit');

  return {
    key: `${sub.id}-${row.lineId}`,
    lineId: row.lineId,
    day,
    monthEnd: false,
    categoryName: row.categoryName,
    categoryColor: row.categoryColor,
    categoryIcon: row.categoryIcon,
    amountCents: row.plannedAmountCents,
    actualAmountCents: row.actualAmountCents,
    isExpense,
    accountId: sub.accountId,
    accountName: sub.accountName,
    subAccountId: sub.id,
    subAccountName: sub.name,
  };
}

function sortDeadlines(items: UpcomingDeadline[]): UpcomingDeadline[] {
  return items.sort((a, b) => a.day - b.day || a.categoryName.localeCompare(b.categoryName, 'fr'));
}

/** Toutes les échéances budget du mois (y compris les jours passés). */
export function collectMonthDeadlines(
  subs: FlatSubAccount[],
  statsBySubId: Record<string, ForecastStats | null>,
): UpcomingDeadline[] {
  const items: UpcomingDeadline[] = [];

  for (const sub of subs) {
    const stats = statsBySubId[sub.id];
    if (!stats?.hasForecast) continue;
    const daysInMonth = stats.meta.daysInMonth;
    for (const row of stats.categories) {
      const item = deadlineFromRow(sub, row, daysInMonth);
      if (item) items.push(item);
    }
  }

  return sortDeadlines(items);
}

/**
 * Échéances budget du mois affiché.
 * Mois courant : jour ≥ aujourd’hui. Mois futurs : toutes. Mois passés : aucune.
 */
export function collectUpcomingDeadlines(
  subs: FlatSubAccount[],
  statsBySubId: Record<string, ForecastStats | null>,
  limit = 6,
  yearMonth?: string,
): UpcomingDeadline[] {
  const current = currentYearMonth();
  const targetMonth = yearMonth ?? current;
  if (targetMonth < current) {
    return [];
  }
  const minDay = targetMonth === current ? new Date().getDate() : 1;

  return collectMonthDeadlines(subs, statsBySubId)
    .filter((item) => item.day >= minDay)
    .slice(0, limit);
}

export function aggregateDashboardForecast(
  yearMonth: string,
  subs: FlatSubAccount[],
  statsBySubId: Record<string, ForecastStats | null>,
): DashboardForecastAggregate {
  const bySubId: Record<string, SubForecastSummary> = {};
  const missingBudget: FlatSubAccount[] = [];
  const overBudgetSubs: FlatSubAccount[] = [];

  let projectedRealisticCents = 0;
  let projectedBudgetCents = 0;
  let plannedIncomeCents = 0;
  let plannedExpenseCents = 0;
  let actualIncomeCents = 0;
  let actualExpenseCents = 0;
  let unbudgetedExpenseCents = 0;
  let unbudgetedIncomeCents = 0;
  let withBudgetCount = 0;
  let meta: ForecastStats['meta'] | null = null;

  for (const sub of subs) {
    const stats = statsBySubId[sub.id] ?? null;
    const hasForecast = Boolean(stats?.hasForecast);
    const overBudget = Boolean(stats?.categories.some((row) => row.overBudget));

    const summary: SubForecastSummary = {
      hasForecast,
      overBudget,
      projectedRealisticCents: hasForecast && stats ? stats.balances.projectedRealisticCents : sub.balanceCents,
      projectedBudgetCents: hasForecast && stats ? stats.balances.projectedBudgetCents : sub.balanceCents,
      currentCents: hasForecast && stats ? stats.balances.currentCents : sub.balanceCents,
    };

    bySubId[sub.id] = summary;
    projectedRealisticCents += summary.projectedRealisticCents;
    projectedBudgetCents += summary.projectedBudgetCents;

    if (hasForecast && stats) {
      withBudgetCount += 1;
      plannedIncomeCents += stats.totals.plannedIncomeCents;
      plannedExpenseCents += stats.totals.plannedExpenseCents;
      actualIncomeCents += stats.totals.actualIncomeCents;
      actualExpenseCents += stats.totals.actualExpenseCents;
      unbudgetedExpenseCents += stats.unbudgeted.expenseCents;
      unbudgetedIncomeCents += stats.unbudgeted.incomeCents;
      if (!meta) {
        meta = stats.meta;
      }
      if (overBudget) {
        overBudgetSubs.push(sub);
      }
    } else {
      missingBudget.push(sub);
    }
  }

  return {
    yearMonth,
    balances: { projectedRealisticCents, projectedBudgetCents },
    totals: {
      plannedIncomeCents,
      plannedExpenseCents,
      actualIncomeCents,
      actualExpenseCents,
    },
    unbudgetedExpenseCents,
    unbudgetedIncomeCents,
    withBudgetCount,
    totalSubsCount: subs.length,
    missingBudget,
    overBudgetSubs,
    bySubId,
    meta,
  };
}
