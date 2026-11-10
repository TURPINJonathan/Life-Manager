<?php

declare(strict_types=1);

namespace App\Module\Account\Service;

use App\Module\Account\Domain\Entity\ForecastLine;
use App\Module\Account\Domain\Entity\MonthlyForecast;
use App\Module\Account\Domain\Entity\SubAccount;
use App\Module\Account\Domain\Entity\Transaction;
use App\Module\Account\Exception\ForecastNotFoundException;
use App\Module\Account\Exception\InvalidForecastException;
use App\Module\Account\Repository\MonthlyForecastRepository;
use App\Module\Account\Repository\TransactionRepository;
use App\Module\Category\Domain\Entity\Category;
use App\Module\Category\Domain\Enum\CategoryKind;
use App\Module\Category\Service\CategoryManager;
use App\Module\Security\Contract\Service\ICurrentUserAccessor;
use Symfony\Component\Uid\Uuid;

final class ForecastManager
{
    public function __construct(
        private readonly MonthlyForecastRepository $forecasts,
        private readonly AccountManager $accounts,
        private readonly CategoryManager $categories,
        private readonly TransactionRepository $transactions,
        private readonly BalanceCalculator $balances,
        private readonly ICurrentUserAccessor $users,
    ) {
    }

    /**
     * @return array<string, mixed>|null
     */
    public function getForMonth(string $subAccountId, string $yearMonth): ?array
    {
        $sub = $this->accounts->requireSubAccountEntity($subAccountId);
        $ym = MonthlyForecast::normalizeYearMonth($yearMonth);
        $forecast = $this->forecasts->findForSubAccountMonth($sub, $ym);

        return null === $forecast ? null : $this->serialize($forecast);
    }

    /**
     * @param array{yearMonth: string, lines?: list<array{categoryId: string, plannedAmountCents: int, flow?: ?string, scheduledDay?: ?int}>} $data
     *
     * @return array<string, mixed>
     */
    public function create(string $subAccountId, array $data): array
    {
        $sub = $this->accounts->requireSubAccountEntity($subAccountId);
        $ym = MonthlyForecast::normalizeYearMonth($data['yearMonth']);

        if (null !== $this->forecasts->findForSubAccountMonth($sub, $ym)) {
            throw new InvalidForecastException(\sprintf('Un budget existe déjà pour %s.', $ym));
        }

        $forecast = new MonthlyForecast($sub, $ym);
        $this->applyLines($forecast, $data['lines'] ?? []);
        $this->forecasts->save($forecast);

        return $this->serialize($forecast);
    }

    /**
     * @param array{sourceYearMonth?: string, targetYearMonth?: string} $data
     *
     * @return array<string, mixed>
     */
    public function duplicate(string $subAccountId, array $data): array
    {
        $sub = $this->accounts->requireSubAccountEntity($subAccountId);
        $target = isset($data['targetYearMonth'])
            ? MonthlyForecast::normalizeYearMonth($data['targetYearMonth'])
            : (new \DateTimeImmutable('first day of this month'))->format('Y-m');
        $source = isset($data['sourceYearMonth'])
            ? MonthlyForecast::normalizeYearMonth($data['sourceYearMonth'])
            : $this->previousYearMonth($target);

        if (null !== $this->forecasts->findForSubAccountMonth($sub, $target)) {
            throw new InvalidForecastException(\sprintf('Un budget existe déjà pour %s.', $target));
        }

        $sourceForecast = $this->forecasts->findForSubAccountMonth($sub, $source);
        if (null === $sourceForecast) {
            throw new ForecastNotFoundException(\sprintf('Aucun budget source pour %s.', $source));
        }

        $forecast = new MonthlyForecast($sub, $target);
        $position = 0;
        foreach ($sourceForecast->getLines() as $line) {
            new ForecastLine(
                $forecast,
                $line->getCategory(),
                $line->getPlannedAmountCents(),
                $line->getFlow(),
                $position++,
                $line->getScheduledDay(),
            );
        }
        $this->forecasts->save($forecast);

        return $this->serialize($forecast);
    }

    /**
     * @param array{lines: list<array{categoryId: string, plannedAmountCents: int, flow?: ?string, scheduledDay?: ?int}>} $data
     *
     * @return array<string, mixed>
     */
    public function update(string $id, array $data): array
    {
        $forecast = $this->requireOwned($id);
        if (!isset($data['lines']) || !\is_array($data['lines'])) {
            throw new InvalidForecastException('Le champ "lines" est requis.');
        }
        $forecast->clearLines();
        $this->applyLines($forecast, $data['lines']);
        $forecast->touch();
        $this->forecasts->save($forecast);

        return $this->serialize($forecast);
    }

    public function delete(string $id): void
    {
        $forecast = $this->requireOwned($id);
        $this->forecasts->remove($forecast);
    }

    /**
     * @return array<string, mixed>
     */
    public function stats(string $subAccountId, string $yearMonth): array
    {
        $sub = $this->accounts->requireSubAccountEntity($subAccountId);

        return $this->statsForSubAccount($sub, $yearMonth);
    }

    /**
     * Stats agrégées pour le dashboard (tous les sous-comptes actifs + optionnellement M−1).
     *
     * @return array{
     *   yearMonth: string,
     *   previousYearMonth: string,
     *   current: array<string, array<string, mixed>>,
     *   previous: array<string, array<string, mixed>>
     * }
     */
    public function statsDashboard(string $yearMonth, bool $includePrevious = true): array
    {
        $ym = MonthlyForecast::normalizeYearMonth($yearMonth);
        $prevYm = $this->previousYearMonth($ym);
        $current = [];
        $previous = [];

        foreach ($this->accounts->listActiveSubAccountEntities() as $sub) {
            $id = (string) $sub->getId();
            $current[$id] = $this->statsForSubAccount($sub, $ym);
            if ($includePrevious) {
                $previous[$id] = $this->statsForSubAccount($sub, $prevYm);
            }
        }

        return [
            'yearMonth'         => $ym,
            'previousYearMonth' => $prevYm,
            'current'           => $current,
            'previous'          => $previous,
        ];
    }

    /**
     * Série mensuelle agrégée (tous les sous-comptes actifs).
     * `calendar` = janvier–décembre de l’année de l’ancre.
     * `rolling` = 12 mois se terminant sur l’ancre.
     *
     * @return array{
     *   anchor: string,
     *   span: string,
     *   from: string,
     *   to: string,
     *   months: list<array{
     *     yearMonth: string,
     *     actualIncomeCents: int,
     *     actualExpenseCents: int,
     *     actualNetCents: int,
     *     plannedIncomeCents: int,
     *     plannedExpenseCents: int,
     *     plannedNetCents: int
     *   }>,
     *   totals: array{
     *     actualIncomeCents: int,
     *     actualExpenseCents: int,
     *     actualNetCents: int,
     *     plannedIncomeCents: int,
     *     plannedExpenseCents: int,
     *     plannedNetCents: int
     *   },
     *   categories: list<array{
     *     categoryId: string,
     *     categoryName: string,
     *     categoryIcon: string,
     *     categoryColor: string,
     *     categoryKind: string,
     *     actualIncomeCents: int,
     *     actualExpenseCents: int,
     *     plannedIncomeCents: int,
     *     plannedExpenseCents: int,
     *     months: list<array{
     *       yearMonth: string,
     *       actualIncomeCents: int,
     *       actualExpenseCents: int,
     *       actualNetCents: int,
     *       plannedIncomeCents: int,
     *       plannedExpenseCents: int,
     *       plannedNetCents: int
     *     }>
     *   }>,
     *   subAccounts: list<array{
     *     subAccountId: string,
     *     subAccountName: string,
     *     accountName: string,
     *     icon: string,
     *     color: string,
     *     months: list<array{
     *       yearMonth: string,
     *       actualIncomeCents: int,
     *       actualExpenseCents: int,
     *       actualNetCents: int,
     *       plannedIncomeCents: int,
     *       plannedExpenseCents: int,
     *       plannedNetCents: int
     *     }>,
     *     totals: array{
     *       actualIncomeCents: int,
     *       actualExpenseCents: int,
     *       actualNetCents: int,
     *       plannedIncomeCents: int,
     *       plannedExpenseCents: int,
     *       plannedNetCents: int
     *     }
     *   }>
     * }
     */
    public function yearSeries(string $anchorYearMonth, string $span): array
    {
        $anchor = MonthlyForecast::normalizeYearMonth($anchorYearMonth);
        [$from, $to] = $this->seriesBounds($anchor, $span);
        $months = $this->emptySeriesMonths($from, $to);

        /** @var array<string, array{
         *   categoryId: string,
         *   categoryName: string,
         *   categoryIcon: string,
         *   categoryColor: string,
         *   categoryKind: string,
         *   actualIncomeCents: int,
         *   actualExpenseCents: int,
         *   plannedIncomeCents: int,
         *   plannedExpenseCents: int,
         *   months: array<string, array<string, int|string>>
         * }> $categories
         */
        $categories = [];
        $ensureCategory = function (
            array &$categories,
            string $id,
            string $name,
            string $icon,
            string $color,
            string $kind,
        ) use ($from, $to): void {
            if (isset($categories[$id])) {
                return;
            }
            $categories[$id] = [
                'categoryId'          => $id,
                'categoryName'        => $name,
                'categoryIcon'        => $icon,
                'categoryColor'       => $color,
                'categoryKind'        => $kind,
                'actualIncomeCents'   => 0,
                'actualExpenseCents'  => 0,
                'plannedIncomeCents'  => 0,
                'plannedExpenseCents' => 0,
                'months'              => $this->emptySeriesMonths($from, $to),
            ];
        };

        /** @var array<string, array{
         *   subAccountId: string,
         *   subAccountName: string,
         *   accountName: string,
         *   icon: string,
         *   color: string,
         *   months: array<string, array<string, int|string>>,
         * }> $bySub
         */
        $bySub = [];
        foreach ($this->accounts->listActiveSubAccountEntities() as $sub) {
            $id = $sub->getId()->toRfc4122();
            $bySub[$id] = [
                'subAccountId'   => $id,
                'subAccountName' => $sub->getName(),
                'accountName'    => $sub->getAccount()->getName(),
                'icon'           => $sub->getIcon(),
                'color'          => $sub->getColor(),
                'months'         => $this->emptySeriesMonths($from, $to),
            ];
        }

        $owner = $this->users->requireUser();
        $fromDate = new \DateTimeImmutable($from.'-01');
        $toDate = (new \DateTimeImmutable($to.'-01'))->modify('last day of this month');

        foreach ($this->transactions->listOwnedAmountsBetween($owner, $fromDate, $toDate) as $row) {
            $ym = $row['operationDate']->format('Y-m');
            if (!isset($months[$ym])) {
                continue;
            }
            $cents = $row['amountCents'];
            $ensureCategory(
                $categories,
                $row['categoryId'],
                $row['categoryName'],
                $row['categoryIcon'],
                $row['categoryColor'],
                $row['categoryKind'],
            );
            $subId = $row['subAccountId'];
            if ($cents > 0) {
                $months[$ym]['actualIncomeCents'] += $cents;
                $categories[$row['categoryId']]['actualIncomeCents'] += $cents;
                $categories[$row['categoryId']]['months'][$ym]['actualIncomeCents'] += $cents;
                if (isset($bySub[$subId]['months'][$ym])) {
                    $bySub[$subId]['months'][$ym]['actualIncomeCents'] += $cents;
                }
            } elseif ($cents < 0) {
                $expense = abs($cents);
                $months[$ym]['actualExpenseCents'] += $expense;
                $categories[$row['categoryId']]['actualExpenseCents'] += $expense;
                $categories[$row['categoryId']]['months'][$ym]['actualExpenseCents'] += $expense;
                if (isset($bySub[$subId]['months'][$ym])) {
                    $bySub[$subId]['months'][$ym]['actualExpenseCents'] += $expense;
                }
            }
        }

        foreach ($this->forecasts->listOwnedBetween($owner, $from, $to) as $forecast) {
            $ym = $forecast->getYearMonth();
            if (!isset($months[$ym])) {
                continue;
            }
            $subId = $forecast->getSubAccount()->getId()->toRfc4122();
            foreach ($forecast->getLines() as $line) {
                $category = $line->getCategory();
                $categoryId = $category->getId()->toRfc4122();
                $ensureCategory(
                    $categories,
                    $categoryId,
                    $category->getName(),
                    $category->getIcon(),
                    $category->getColor(),
                    $category->getKind()->value,
                );
                $signed = AmountFromCategory::signedCents(
                    $category,
                    $line->getPlannedAmountCents(),
                    $line->getFlow(),
                    true,
                );
                if ($signed > 0) {
                    $months[$ym]['plannedIncomeCents'] += $signed;
                    $categories[$categoryId]['plannedIncomeCents'] += $signed;
                    $categories[$categoryId]['months'][$ym]['plannedIncomeCents'] += $signed;
                    if (isset($bySub[$subId]['months'][$ym])) {
                        $bySub[$subId]['months'][$ym]['plannedIncomeCents'] += $signed;
                    }
                } elseif ($signed < 0) {
                    $expense = abs($signed);
                    $months[$ym]['plannedExpenseCents'] += $expense;
                    $categories[$categoryId]['plannedExpenseCents'] += $expense;
                    $categories[$categoryId]['months'][$ym]['plannedExpenseCents'] += $expense;
                    if (isset($bySub[$subId]['months'][$ym])) {
                        $bySub[$subId]['months'][$ym]['plannedExpenseCents'] += $expense;
                    }
                }
            }
        }

        [$list, $totals] = $this->finalizeSeriesMonths($months);
        $categoryList = [];
        foreach ($categories as $categoryRow) {
            [$categoryMonths] = $this->finalizeSeriesMonths($categoryRow['months']);
            unset($categoryRow['months']);
            $categoryRow['months'] = $categoryMonths;
            $categoryList[] = $categoryRow;
        }
        usort(
            $categoryList,
            static function (array $a, array $b): int {
                // Revenus d’abord, puis dépenses ; alphabétique dans chaque groupe.
                $aExpense = self::seriesCategoryIsExpenseGroup($a);
                $bExpense = self::seriesCategoryIsExpenseGroup($b);
                if ($aExpense !== $bExpense) {
                    return $aExpense <=> $bExpense;
                }

                return strcasecmp($a['categoryName'], $b['categoryName']);
            },
        );

        $subAccounts = [];
        foreach ($bySub as $subRow) {
            [$subMonths, $subTotals] = $this->finalizeSeriesMonths($subRow['months']);
            $subAccounts[] = [
                'subAccountId'   => $subRow['subAccountId'],
                'subAccountName' => $subRow['subAccountName'],
                'accountName'    => $subRow['accountName'],
                'icon'           => $subRow['icon'],
                'color'          => $subRow['color'],
                'months'         => $subMonths,
                'totals'         => $subTotals,
            ];
        }
        usort(
            $subAccounts,
            static fn (array $a, array $b): int => strcmp($a['accountName'], $b['accountName'])
                ?: strcmp($a['subAccountName'], $b['subAccountName']),
        );

        return [
            'anchor'      => $anchor,
            'span'        => $span,
            'from'        => $from,
            'to'          => $to,
            'months'      => $list,
            'totals'      => $totals,
            'categories'  => $categoryList,
            'subAccounts' => $subAccounts,
        ];
    }

    /**
     * @return array<string, array{
     *   yearMonth: string,
     *   actualIncomeCents: int,
     *   actualExpenseCents: int,
     *   actualNetCents: int,
     *   plannedIncomeCents: int,
     *   plannedExpenseCents: int,
     *   plannedNetCents: int
     * }>
     */
    private function emptySeriesMonths(string $from, string $to): array
    {
        $months = [];
        $cursor = new \DateTimeImmutable($from.'-01');
        $end = new \DateTimeImmutable($to.'-01');
        while ($cursor <= $end) {
            $ym = $cursor->format('Y-m');
            $months[$ym] = [
                'yearMonth'           => $ym,
                'actualIncomeCents'   => 0,
                'actualExpenseCents'  => 0,
                'actualNetCents'      => 0,
                'plannedIncomeCents'  => 0,
                'plannedExpenseCents' => 0,
                'plannedNetCents'     => 0,
            ];
            $cursor = $cursor->modify('+1 month');
        }

        return $months;
    }

    /**
     * @param array<string, array{
     *   yearMonth: string,
     *   actualIncomeCents: int,
     *   actualExpenseCents: int,
     *   actualNetCents: int,
     *   plannedIncomeCents: int,
     *   plannedExpenseCents: int,
     *   plannedNetCents: int
     * }> $months
     *
     * @return array{
     *   0: list<array{
     *     yearMonth: string,
     *     actualIncomeCents: int,
     *     actualExpenseCents: int,
     *     actualNetCents: int,
     *     plannedIncomeCents: int,
     *     plannedExpenseCents: int,
     *     plannedNetCents: int
     *   }>,
     *   1: array{
     *     actualIncomeCents: int,
     *     actualExpenseCents: int,
     *     actualNetCents: int,
     *     plannedIncomeCents: int,
     *     plannedExpenseCents: int,
     *     plannedNetCents: int
     *   }
     * }
     */
    private function finalizeSeriesMonths(array $months): array
    {
        $totals = [
            'actualIncomeCents'   => 0,
            'actualExpenseCents'  => 0,
            'actualNetCents'      => 0,
            'plannedIncomeCents'  => 0,
            'plannedExpenseCents' => 0,
            'plannedNetCents'     => 0,
        ];
        $list = [];
        foreach ($months as $bucket) {
            $bucket['actualNetCents'] = $bucket['actualIncomeCents'] - $bucket['actualExpenseCents'];
            $bucket['plannedNetCents'] = $bucket['plannedIncomeCents'] - $bucket['plannedExpenseCents'];
            $totals['actualIncomeCents'] += $bucket['actualIncomeCents'];
            $totals['actualExpenseCents'] += $bucket['actualExpenseCents'];
            $totals['plannedIncomeCents'] += $bucket['plannedIncomeCents'];
            $totals['plannedExpenseCents'] += $bucket['plannedExpenseCents'];
            $list[] = $bucket;
        }
        $totals['actualNetCents'] = $totals['actualIncomeCents'] - $totals['actualExpenseCents'];
        $totals['plannedNetCents'] = $totals['plannedIncomeCents'] - $totals['plannedExpenseCents'];

        return [$list, $totals];
    }

    /**
     * @return array{0: string, 1: string}
     */
    private function seriesBounds(string $anchor, string $span): array
    {
        if ('calendar' === $span) {
            $year = substr($anchor, 0, 4);

            return [$year.'-01', $year.'-12'];
        }
        if ('rolling' === $span) {
            $end = new \DateTimeImmutable($anchor.'-01');
            $start = $end->modify('-11 months');

            return [$start->format('Y-m'), $end->format('Y-m')];
        }

        throw new \InvalidArgumentException('Le paramètre span doit être calendar ou rolling.');
    }

    /**
     * @param array{
     *   categoryKind: string,
     *   actualIncomeCents: int,
     *   actualExpenseCents: int,
     *   plannedIncomeCents: int,
     *   plannedExpenseCents: int
     * } $row
     */
    private static function seriesCategoryIsExpenseGroup(array $row): bool
    {
        if ('expense' === $row['categoryKind']) {
            return true;
        }
        if ('income' === $row['categoryKind']) {
            return false;
        }

        $expenseWeight = $row['actualExpenseCents'] + $row['plannedExpenseCents'];
        $incomeWeight = $row['actualIncomeCents'] + $row['plannedIncomeCents'];

        return $expenseWeight >= $incomeWeight;
    }

    /**
     * @return array<string, mixed>
     */
    private function statsForSubAccount(SubAccount $sub, string $yearMonth): array
    {
        return $this->computeStats($sub, MonthlyForecast::normalizeYearMonth($yearMonth));
    }

    /**
     * @return array<string, mixed>
     */
    private function computeStats(SubAccount $sub, string $ym): array
    {
        [$from, $to] = $this->monthBounds($ym);
        $today = new \DateTimeImmutable('today');

        $openingBalanceCents = $sub->getOpeningBalanceCents()
            + $this->transactions->sumAmountCentsBefore($sub, $from);
        $monthTx = $this->transactions->listForSubAccountBetween($sub, $from, $to);
        $actualNetCents = 0;
        $actualIncomeCents = 0;
        $actualExpenseCents = 0;
        /** @var array<string, int> $actualByCategory */
        $actualByCategory = [];

        foreach ($monthTx as $tx) {
            $cents = $tx->getAmountCents();
            $actualNetCents += $cents;
            if ($cents > 0) {
                $actualIncomeCents += $cents;
            } else {
                $actualExpenseCents += abs($cents);
            }
            $catId = (string) $tx->getCategory()->getId();
            $actualByCategory[$catId] = ($actualByCategory[$catId] ?? 0) + $cents;
        }

        $currentBalanceCents = $this->balances->currentBalanceCents($sub);
        $endOfMonthActualCents = $openingBalanceCents + $actualNetCents;

        $forecast = $this->syncMissingCategoryLinesFromOperations($sub, $ym, $monthTx);
        $plannedIncomeCents = 0;
        $plannedExpenseCents = 0;
        $categoryRows = [];
        $budgetedCategoryIds = [];

        if (null !== $forecast) {
            /** @var array<string, int> $plannedAbsByCategory */
            $plannedAbsByCategory = [];
            /** @var array<string, int> $lastLineIndexByCategory */
            $lastLineIndexByCategory = [];
            foreach ($forecast->getLines() as $index => $line) {
                $catId = (string) $line->getCategory()->getId();
                $plannedAbsByCategory[$catId] = ($plannedAbsByCategory[$catId] ?? 0) + $line->getPlannedAmountCents();
                $lastLineIndexByCategory[$catId] = $index;
            }

            /** @var array<string, int> $allocatedActualAbs */
            $allocatedActualAbs = [];

            foreach ($forecast->getLines() as $index => $line) {
                $cat = $line->getCategory();
                $catId = (string) $cat->getId();
                $budgetedCategoryIds[$catId] = true;
                $signedPlanned = AmountFromCategory::signedCents($cat, $line->getPlannedAmountCents(), $line->getFlow(), true);
                $isExpense = AmountFromCategory::isExpense($cat, $line->getFlow());
                if ($signedPlanned > 0) {
                    $plannedIncomeCents += $signedPlanned;
                } elseif ($signedPlanned < 0) {
                    $plannedExpenseCents += abs($signedPlanned);
                }

                $categoryActualSigned = $actualByCategory[$catId] ?? 0;
                $categoryActualAbs = abs($categoryActualSigned);
                $plannedAbs = $line->getPlannedAmountCents();
                $categoryPlannedAbs = $plannedAbsByCategory[$catId] ?? 0;
                $allocated = $allocatedActualAbs[$catId] ?? 0;
                $isLastForCategory = ($lastLineIndexByCategory[$catId] ?? -1) === $index;

                if ($categoryPlannedAbs <= 0) {
                    $lineActualAbs = $isLastForCategory ? max(0, $categoryActualAbs - $allocated) : 0;
                } elseif ($isLastForCategory) {
                    $lineActualAbs = max(0, $categoryActualAbs - $allocated);
                } else {
                    $lineActualAbs = (int) round($categoryActualAbs * ($plannedAbs / $categoryPlannedAbs));
                }
                $allocatedActualAbs[$catId] = $allocated + $lineActualAbs;

                $lineActualSigned = $categoryActualSigned < 0 ? -$lineActualAbs : $lineActualAbs;
                $remaining = $plannedAbs - $lineActualAbs;
                $consumptionPercent = $plannedAbs > 0 ? (int) round(($lineActualAbs / $plannedAbs) * 100) : ($lineActualAbs > 0 ? 100 : 0);
                $overBudget = $isExpense && $lineActualAbs > $plannedAbs;

                $categoryRows[] = [
                    'lineId'             => (string) $line->getId(),
                    'categoryId'         => $catId,
                    'categoryName'       => $cat->getName(),
                    'categoryIcon'       => $cat->getIcon(),
                    'categoryColor'      => $cat->getColor(),
                    'categoryKind'       => $cat->getKind()->value,
                    'flow'               => $line->getFlow(),
                    'scheduledDay'       => $line->getScheduledDay(),
                    'plannedAmountCents' => $plannedAbs,
                    'plannedSignedCents' => $signedPlanned,
                    'actualSignedCents'  => $lineActualSigned,
                    'actualAmountCents'  => $lineActualAbs,
                    'remainingCents'     => $remaining,
                    'consumptionPercent' => $consumptionPercent,
                    'overBudget'         => $overBudget,
                    'isExpense'          => $isExpense,
                ];
            }
        }

        $unbudgetedIncomeCents = 0;
        $unbudgetedExpenseCents = 0;
        $unbudgeted = [];
        foreach ($actualByCategory as $catId => $signed) {
            if (isset($budgetedCategoryIds[$catId])) {
                continue;
            }
            if ($signed > 0) {
                $unbudgetedIncomeCents += $signed;
            } else {
                $unbudgetedExpenseCents += abs($signed);
            }
            $txCat = null;
            foreach ($monthTx as $tx) {
                if ((string) $tx->getCategory()->getId() === $catId) {
                    $txCat = $tx->getCategory();
                    break;
                }
            }
            $unbudgeted[] = [
                'categoryId'        => $catId,
                'categoryName'      => $txCat?->getName(),
                'categoryIcon'      => $txCat?->getIcon(),
                'categoryColor'     => $txCat?->getColor(),
                'actualSignedCents' => $signed,
                'actualAmountCents' => abs($signed),
            ];
        }

        $plannedNetCents = $plannedIncomeCents - $plannedExpenseCents;
        $projectedBudgetCents = $openingBalanceCents + $plannedNetCents;

        // Remaining planned: for expense lines, max(0, planned - actual); for income, max(0, planned - actual)
        $remainingPlannedNet = 0;
        foreach ($categoryRows as $row) {
            if ($row['isExpense']) {
                $remainingPlannedNet -= max(0, $row['plannedAmountCents'] - $row['actualAmountCents']);
            } else {
                $remainingPlannedNet += max(0, $row['plannedAmountCents'] - $row['actualAmountCents']);
            }
        }
        $projectedRealisticCents = $openingBalanceCents + $actualNetCents + $remainingPlannedNet;

        $daysInMonth = (int) $to->format('t');
        $isCurrentMonth = $today->format('Y-m') === $ym;
        $isPastMonth = $today > $to;
        $isFutureMonth = $today < $from;
        $daysElapsed = match (true) {
            $isFutureMonth => 0,
            $isPastMonth   => $daysInMonth,
            default        => (int) $today->format('j'),
        };
        $daysRemaining = max(0, $daysInMonth - $daysElapsed);

        $timeline = $this->buildTimeline(
            $ym,
            $daysInMonth,
            $daysElapsed,
            $openingBalanceCents,
            $monthTx,
            $forecast,
            $categoryRows,
        );

        $previousMonth = $this->buildPreviousMonthSnapshot($sub, $ym, $categoryRows);

        return [
            'yearMonth'   => $ym,
            'hasForecast' => null !== $forecast,
            'forecastId'  => null !== $forecast ? (string) $forecast->getId() : null,
            'balances'    => [
                'openingCents'                   => $openingBalanceCents,
                'currentCents'                   => $currentBalanceCents,
                'endOfMonthActualCents'          => $endOfMonthActualCents,
                'projectedBudgetCents'           => $projectedBudgetCents,
                'projectedRealisticCents'        => $projectedRealisticCents,
                'varianceBudgetVsActualNetCents' => $plannedNetCents - $actualNetCents,
            ],
            'totals' => [
                'plannedIncomeCents'  => $plannedIncomeCents,
                'plannedExpenseCents' => $plannedExpenseCents,
                'plannedNetCents'     => $plannedNetCents,
                'actualIncomeCents'   => $actualIncomeCents,
                'actualExpenseCents'  => $actualExpenseCents,
                'actualNetCents'      => $actualNetCents,
            ],
            'categories' => $categoryRows,
            'unbudgeted' => [
                'incomeCents'  => $unbudgetedIncomeCents,
                'expenseCents' => $unbudgetedExpenseCents,
                'items'        => $unbudgeted,
            ],
            'previousMonth' => $previousMonth,
            'timeline'      => $timeline,
            'meta'          => [
                'daysInMonth'    => $daysInMonth,
                'daysElapsed'    => $daysElapsed,
                'daysRemaining'  => $daysRemaining,
                'isCurrentMonth' => $isCurrentMonth,
                'isPastMonth'    => $isPastMonth,
                'isFutureMonth'  => $isFutureMonth,
            ],
        ];
    }

    /**
     * @param list<Transaction>          $monthTx
     * @param list<array<string, mixed>> $categoryRows
     *
     * @return list<array<string, mixed>>
     */
    private function buildTimeline(
        string $yearMonth,
        int $daysInMonth,
        int $daysElapsed,
        int $openingBalanceCents,
        array $monthTx,
        ?MonthlyForecast $forecast,
        array $categoryRows,
    ): array {
        /** @var array<int, int> $actualByDay */
        $actualByDay = [];
        /** @var array<int, list<array<string, mixed>>> $actualEventsByDay */
        $actualEventsByDay = [];
        foreach ($monthTx as $tx) {
            $operationDate = $tx->getOperationDate();
            $day = (int) $operationDate->format('j');
            $actualByDay[$day] = ($actualByDay[$day] ?? 0) + $tx->getAmountCents();
            $cat = $tx->getCategory();
            $actualEventsByDay[$day][] = [
                'kind'          => 'actual',
                'label'         => $tx->getDesignation(),
                'categoryName'  => $cat->getName(),
                'categoryColor' => $cat->getColor(),
                'amountCents'   => $tx->getAmountCents(),
            ];
        }

        /** @var array<int, int> $plannedByDay */
        $plannedByDay = [];
        /** @var array<int, list<array<string, mixed>>> $plannedEventsByDay */
        $plannedEventsByDay = [];
        $unscheduledPlanned = 0;
        if (null !== $forecast) {
            foreach ($forecast->getLines() as $line) {
                $cat = $line->getCategory();
                $signed = AmountFromCategory::signedCents($cat, $line->getPlannedAmountCents(), $line->getFlow(), true);
                $day = $line->getScheduledDay();
                $event = [
                    'kind'          => 'planned',
                    'label'         => $cat->getName(),
                    'categoryName'  => $cat->getName(),
                    'categoryColor' => $cat->getColor(),
                    'amountCents'   => $signed,
                ];
                if (null === $day) {
                    // Flexible : pas d’événement daté — lissé sur le mois (courbe budget).
                    $unscheduledPlanned += $signed;
                    continue;
                }
                $clamped = min($daysInMonth, max(1, $day));
                $plannedByDay[$clamped] = ($plannedByDay[$clamped] ?? 0) + $signed;
                $plannedEventsByDay[$clamped][] = $event;
            }
        }
        foreach ($this->distributeCentsByDay($unscheduledPlanned, 1, $daysInMonth) as $day => $cents) {
            $plannedByDay[$day] = ($plannedByDay[$day] ?? 0) + $cents;
        }

        /** @var array<int, int> $futurePlannedByDay */
        $futurePlannedByDay = [];
        foreach ($categoryRows as $row) {
            $signed = (int) $row['plannedSignedCents'];
            $remainingAbs = max(0, (int) $row['plannedAmountCents'] - (int) $row['actualAmountCents']);
            if ($remainingAbs <= 0) {
                continue;
            }
            $remainingSigned = $signed < 0 ? -$remainingAbs : $remainingAbs;
            $day = $row['scheduledDay'] ?? null;
            if (!\is_int($day)) {
                // Reste flexible : lissé d’aujourd’hui (ou jour 1) à la fin du mois.
                $from = max(1, $daysElapsed > 0 ? $daysElapsed : 1);
                foreach ($this->distributeCentsByDay($remainingSigned, $from, $daysInMonth) as $spreadDay => $cents) {
                    $futurePlannedByDay[$spreadDay] = ($futurePlannedByDay[$spreadDay] ?? 0) + $cents;
                }
                continue;
            }
            $clamped = min($daysInMonth, max(1, $day));
            if ($clamped <= $daysElapsed) {
                // Past-due remainder: apply on "today" (or day 1 if future month).
                $applyOn = max(1, $daysElapsed);
                $futurePlannedByDay[$applyOn] = ($futurePlannedByDay[$applyOn] ?? 0) + $remainingSigned;
                continue;
            }
            $futurePlannedByDay[$clamped] = ($futurePlannedByDay[$clamped] ?? 0) + $remainingSigned;
        }

        $budgetBalance = $openingBalanceCents;
        $actualBalance = $openingBalanceCents;
        $realisticBalance = $openingBalanceCents;
        $points = [];

        // Point 0 = solde d’ouverture (avant tout mouvement du mois).
        $points[] = [
            'day'                   => 0,
            'date'                  => $yearMonth.'-01',
            'budgetBalanceCents'    => $openingBalanceCents,
            'realisticBalanceCents' => $openingBalanceCents,
            'actualBalanceCents'    => $daysElapsed >= 0 ? $openingBalanceCents : null,
            'events'                => [],
        ];

        for ($day = 1; $day <= $daysInMonth; ++$day) {
            $date = \sprintf('%s-%02d', $yearMonth, $day);
            $budgetBalance += $plannedByDay[$day] ?? 0;
            $dayActual = $actualByDay[$day] ?? 0;
            if ($day <= $daysElapsed) {
                $actualBalance += $dayActual;
                $realisticBalance = $actualBalance;
                if ($day === $daysElapsed) {
                    // Remainders of past-due / due-today planned lines.
                    $realisticBalance += $futurePlannedByDay[$day] ?? 0;
                }
            } else {
                $realisticBalance += $futurePlannedByDay[$day] ?? 0;
            }

            $events = array_merge($plannedEventsByDay[$day] ?? [], $actualEventsByDay[$day] ?? []);
            $points[] = [
                'day'                   => $day,
                'date'                  => $date,
                'budgetBalanceCents'    => $budgetBalance,
                'realisticBalanceCents' => $realisticBalance,
                'actualBalanceCents'    => $day <= $daysElapsed ? $actualBalance : null,
                'events'                => $events,
            ];
        }

        return $points;
    }

    /**
     * Répartit un montant signé sur [fromDay, toDay] sans dérive (arrondi cumulatif).
     *
     * @return array<int, int> day => cents
     */
    private function distributeCentsByDay(int $totalCents, int $fromDay, int $toDay): array
    {
        if (0 === $totalCents || $fromDay > $toDay) {
            return [];
        }

        $days = $toDay - $fromDay + 1;
        $result = [];
        $distributed = 0;
        for ($i = 1; $i <= $days; ++$i) {
            $target = (int) round($totalCents * $i / $days);
            $result[$fromDay + $i - 1] = $target - $distributed;
            $distributed = $target;
        }

        return $result;
    }

    private function requireOwned(string $id): MonthlyForecast
    {
        $forecast = $this->forecasts->findOwned(Uuid::fromString($id), $this->users->requireUser());
        if (null === $forecast) {
            throw new ForecastNotFoundException();
        }

        return $forecast;
    }

    /**
     * @param list<array{categoryId: string, plannedAmountCents: int, flow?: ?string, scheduledDay?: ?int|mixed}> $lines
     */
    private function applyLines(MonthlyForecast $forecast, array $lines): void
    {
        $position = 0;
        foreach ($lines as $index => $row) {
            if (!\is_array($row) || !isset($row['categoryId'], $row['plannedAmountCents'])) {
                throw new InvalidForecastException(\sprintf('Ligne %d invalide.', $index));
            }
            $categoryId = (string) $row['categoryId'];
            $category = $this->categories->requireOwnedEntity($categoryId);
            $amount = (int) $row['plannedAmountCents'];
            $flow = isset($row['flow']) && \is_string($row['flow']) ? $row['flow'] : null;
            AmountFromCategory::signedCents($category, $amount, $flow, true);
            if (CategoryKind::Both !== $category->getKind()) {
                $flow = null;
            }
            $scheduledDay = $this->normalizeScheduledDay($row['scheduledDay'] ?? null, $index);
            new ForecastLine($forecast, $category, $amount, $flow, $position++, $scheduledDay);
        }
    }

    private function normalizeScheduledDay(mixed $raw, int $lineIndex): ?int
    {
        if (null === $raw || '' === $raw) {
            return null;
        }
        if (!\is_int($raw) && !(is_numeric($raw) && (string) (int) $raw === (string) $raw)) {
            throw new InvalidForecastException(\sprintf('Ligne %d : scheduledDay doit être un entier ou null.', $lineIndex));
        }
        $day = (int) $raw;
        if ($day < 1 || $day > 31) {
            throw new InvalidForecastException(\sprintf('Ligne %d : le jour doit être entre 1 et 31.', $lineIndex));
        }

        return $day;
    }

    /**
     * @return array{0: \DateTimeImmutable, 1: \DateTimeImmutable}
     */
    private function monthBounds(string $yearMonth): array
    {
        $from = new \DateTimeImmutable($yearMonth.'-01');
        $to = $from->modify('last day of this month');

        return [$from, $to];
    }

    private function previousYearMonth(string $yearMonth): string
    {
        return (new \DateTimeImmutable($yearMonth.'-01'))->modify('-1 month')->format('Y-m');
    }

    /**
     * Snapshot indicatif du mois précédent (n’entre pas dans les totaux / timeline courants).
     *
     * @param list<array<string, mixed>> $categoryRows
     *
     * @return array{
     *   yearMonth: string,
     *   hasForecast: bool,
     *   totals: array{plannedIncomeCents: int, plannedExpenseCents: int, actualIncomeCents: int, actualExpenseCents: int},
     *   categories: list<array<string, mixed>>,
     *   orphans: list<array<string, mixed>>
     * }
     */
    private function buildPreviousMonthSnapshot(SubAccount $sub, string $yearMonth, array $categoryRows): array
    {
        $prevYm = $this->previousYearMonth($yearMonth);
        [$prevFrom, $prevTo] = $this->monthBounds($prevYm);
        $prevTx = $this->transactions->listForSubAccountBetween($sub, $prevFrom, $prevTo);
        $prevForecast = $this->forecasts->findForSubAccountMonth($sub, $prevYm);

        /** @var array<string, array{category: Category, flow: ?string, isExpense: bool, actualSigned: int, plannedAbs: int, plannedSigned: int, lines: list<array{plannedAmountCents: int, scheduledDay: ?int}>}> $byKey */
        $byKey = [];

        foreach ($prevTx as $tx) {
            $category = $tx->getCategory();
            $flow = CategoryKind::Both === $category->getKind()
                ? ($tx->getAmountCents() >= 0 ? 'credit' : 'debit')
                : null;
            $key = (string) $category->getId().':'.($flow ?? '');
            if (!isset($byKey[$key])) {
                $byKey[$key] = [
                    'category'      => $category,
                    'flow'          => $flow,
                    'isExpense'     => AmountFromCategory::isExpense($category, $flow),
                    'actualSigned'  => 0,
                    'plannedAbs'    => 0,
                    'plannedSigned' => 0,
                    'lines'         => [],
                ];
            }
            $byKey[$key]['actualSigned'] += $tx->getAmountCents();
        }

        if (null !== $prevForecast) {
            foreach ($prevForecast->getLines() as $line) {
                $category = $line->getCategory();
                $flow = $line->getFlow();
                if (CategoryKind::Both !== $category->getKind()) {
                    $flow = null;
                }
                $key = (string) $category->getId().':'.($flow ?? '');
                $signed = AmountFromCategory::signedCents($category, $line->getPlannedAmountCents(), $flow, true);
                if (!isset($byKey[$key])) {
                    $byKey[$key] = [
                        'category'      => $category,
                        'flow'          => $flow,
                        'isExpense'     => AmountFromCategory::isExpense($category, $flow),
                        'actualSigned'  => 0,
                        'plannedAbs'    => 0,
                        'plannedSigned' => 0,
                        'lines'         => [],
                    ];
                }
                $byKey[$key]['plannedAbs'] += $line->getPlannedAmountCents();
                $byKey[$key]['plannedSigned'] += $signed;
                $byKey[$key]['lines'][] = [
                    'plannedAmountCents' => $line->getPlannedAmountCents(),
                    'scheduledDay'       => $line->getScheduledDay(),
                ];
            }
        }

        /** @var array<string, true> $currentKeys */
        $currentKeys = [];
        /** @var array<string, array<string, mixed>> $currentMetaByKey */
        $currentMetaByKey = [];
        foreach ($categoryRows as $row) {
            $flow = $row['flow'] ?? null;
            $flowKey = \is_string($flow) ? $flow : '';
            $key = (string) $row['categoryId'].':'.$flowKey;
            $currentKeys[$key] = true;
            $currentMetaByKey[$key] = $row;
        }

        $categories = [];
        $orphans = [];
        $plannedIncomeCents = 0;
        $plannedExpenseCents = 0;
        $actualIncomeCents = 0;
        $actualExpenseCents = 0;

        foreach ($byKey as $key => $info) {
            $previousLines = $info['lines'];
            usort(
                $previousLines,
                static fn (array $a, array $b): int => ($a['scheduledDay'] ?? 32) <=> ($b['scheduledDay'] ?? 32)
                    ?: $a['plannedAmountCents'] <=> $b['plannedAmountCents'],
            );

            $payload = [
                'categoryId'                 => (string) $info['category']->getId(),
                'categoryName'               => $info['category']->getName(),
                'categoryIcon'               => $info['category']->getIcon(),
                'categoryColor'              => $info['category']->getColor(),
                'categoryKind'               => $info['category']->getKind()->value,
                'flow'                       => $info['flow'],
                'isExpense'                  => $info['isExpense'],
                'previousActualSignedCents'  => $info['actualSigned'],
                'previousActualAmountCents'  => abs($info['actualSigned']),
                'previousPlannedAmountCents' => $info['plannedAbs'],
                'previousPlannedSignedCents' => $info['plannedSigned'],
                'previousLines'              => $previousLines,
            ];

            if ($info['plannedSigned'] > 0) {
                $plannedIncomeCents += $info['plannedSigned'];
            } elseif ($info['plannedSigned'] < 0) {
                $plannedExpenseCents += abs($info['plannedSigned']);
            }
            if ($info['actualSigned'] > 0) {
                $actualIncomeCents += $info['actualSigned'];
            } elseif ($info['actualSigned'] < 0) {
                $actualExpenseCents += abs($info['actualSigned']);
            }

            if (isset($currentKeys[$key])) {
                $categories[] = $payload;
                unset($currentKeys[$key]);
            } else {
                $orphans[] = $payload;
            }
        }

        // Catégories du budget courant sans historique M-1 → entrée à 0 (toujours affichable).
        foreach ($currentKeys as $key => $_) {
            $meta = $currentMetaByKey[$key] ?? null;
            if (null === $meta) {
                continue;
            }
            $flow = $meta['flow'] ?? null;
            $categories[] = [
                'categoryId'                 => (string) $meta['categoryId'],
                'categoryName'               => (string) $meta['categoryName'],
                'categoryIcon'               => (string) $meta['categoryIcon'],
                'categoryColor'              => (string) $meta['categoryColor'],
                'categoryKind'               => (string) $meta['categoryKind'],
                'flow'                       => \is_string($flow) ? $flow : null,
                'isExpense'                  => (bool) ($meta['isExpense'] ?? false),
                'previousActualSignedCents'  => 0,
                'previousActualAmountCents'  => 0,
                'previousPlannedAmountCents' => 0,
                'previousPlannedSignedCents' => 0,
                'previousLines'              => [],
            ];
        }

        usort($categories, static fn (array $a, array $b): int => strcmp($a['categoryName'], $b['categoryName']));
        usort($orphans, static fn (array $a, array $b): int => strcmp($a['categoryName'], $b['categoryName']));

        return [
            'yearMonth'   => $prevYm,
            'hasForecast' => null !== $prevForecast,
            'totals'      => [
                'plannedIncomeCents'  => $plannedIncomeCents,
                'plannedExpenseCents' => $plannedExpenseCents,
                'actualIncomeCents'   => $actualIncomeCents,
                'actualExpenseCents'  => $actualExpenseCents,
            ],
            'categories' => $categories,
            'orphans'    => $orphans,
        ];
    }

    /**
     * Si des opérations du mois portent une catégorie absente du budget :
     * crée le forecast si besoin et ajoute une ligne planifiée à 0 €.
     *
     * @param list<Transaction> $monthTx
     */
    private function syncMissingCategoryLinesFromOperations(
        SubAccount $sub,
        string $yearMonth,
        array $monthTx,
    ): ?MonthlyForecast {
        $forecast = $this->forecasts->findForSubAccountMonth($sub, $yearMonth);
        if ([] === $monthTx) {
            return $forecast;
        }

        $created = false;
        if (null === $forecast) {
            $forecast = new MonthlyForecast($sub, $yearMonth);
            $created = true;
        }

        /** @var array<string, true> $existing */
        $existing = [];
        $position = 0;
        foreach ($forecast->getLines() as $line) {
            $key = (string) $line->getCategory()->getId().':'.($line->getFlow() ?? '');
            $existing[$key] = true;
            $position = max($position, $line->getPosition() + 1);
        }

        $added = false;
        /** @var array<string, array{category: Category, flow: ?string, day: int}> $needed */
        $needed = [];
        foreach ($monthTx as $tx) {
            $category = $tx->getCategory();
            $flow = CategoryKind::Both === $category->getKind()
                ? ($tx->getAmountCents() >= 0 ? 'credit' : 'debit')
                : null;
            $key = (string) $category->getId().':'.($flow ?? '');
            if (!isset($needed[$key])) {
                $needed[$key] = [
                    'category' => $category,
                    'flow'     => $flow,
                    'day'      => (int) $tx->getOperationDate()->format('j'),
                ];
            }
        }

        foreach ($needed as $key => $info) {
            if (isset($existing[$key])) {
                continue;
            }
            new ForecastLine(
                $forecast,
                $info['category'],
                0,
                $info['flow'],
                $position++,
                $info['day'],
            );
            $existing[$key] = true;
            $added = true;
        }

        if ($created || $added) {
            $forecast->touch();
            $this->forecasts->save($forecast);
        }

        return $forecast;
    }

    /**
     * Si la catégorie n’est pas dans le budget du mois d’opération, crée le budget si besoin
     * et ajoute une ligne (montant planifié 0 €, jour = jour d’opération).
     *
     * @return array{added: bool, categoryName: ?string, yearMonth: ?string}
     */
    public function ensureCategoryLineForTransaction(Transaction $tx): array
    {
        if (0 === $tx->getAmountCents()) {
            return ['added' => false, 'categoryName' => null, 'yearMonth' => null];
        }

        $operationDate = $tx->getOperationDate();
        $yearMonth = $operationDate->format('Y-m');
        $sub = $tx->getSubAccount();
        $category = $tx->getCategory();
        $flow = CategoryKind::Both === $category->getKind()
            ? ($tx->getAmountCents() >= 0 ? 'credit' : 'debit')
            : null;

        $forecast = $this->forecasts->findForSubAccountMonth($sub, $yearMonth);
        if (null !== $forecast) {
            foreach ($forecast->getLines() as $line) {
                if ((string) $line->getCategory()->getId() !== (string) $category->getId()) {
                    continue;
                }
                if (CategoryKind::Both === $category->getKind() && $line->getFlow() !== $flow) {
                    continue;
                }

                return ['added' => false, 'categoryName' => null, 'yearMonth' => null];
            }
        } else {
            $forecast = new MonthlyForecast($sub, $yearMonth);
        }

        $position = 0;
        foreach ($forecast->getLines() as $line) {
            $position = max($position, $line->getPosition() + 1);
        }

        new ForecastLine(
            $forecast,
            $category,
            0,
            $flow,
            $position,
            (int) $operationDate->format('j'),
        );
        $forecast->touch();
        $this->forecasts->save($forecast);

        return [
            'added'        => true,
            'categoryName' => $category->getName(),
            'yearMonth'    => $yearMonth,
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serialize(MonthlyForecast $forecast): array
    {
        $lines = [];
        foreach ($forecast->getLines() as $line) {
            $cat = $line->getCategory();
            $lines[] = [
                'id'                 => (string) $line->getId(),
                'categoryId'         => (string) $cat->getId(),
                'categoryName'       => $cat->getName(),
                'categoryIcon'       => $cat->getIcon(),
                'categoryColor'      => $cat->getColor(),
                'categoryKind'       => $cat->getKind()->value,
                'plannedAmountCents' => $line->getPlannedAmountCents(),
                'flow'               => $line->getFlow(),
                'scheduledDay'       => $line->getScheduledDay(),
                'position'           => $line->getPosition(),
            ];
        }

        return [
            'id'           => (string) $forecast->getId(),
            'subAccountId' => (string) $forecast->getSubAccount()->getId(),
            'yearMonth'    => $forecast->getYearMonth(),
            'lines'        => $lines,
            'createdAt'    => $forecast->getCreatedAt()->format(\DateTimeInterface::ATOM),
            'updatedAt'    => $forecast->getUpdatedAt()->format(\DateTimeInterface::ATOM),
        ];
    }
}
