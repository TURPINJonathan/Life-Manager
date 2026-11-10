<?php

declare(strict_types=1);

namespace App\Module\Work\Service;

use App\Module\Work\Contract\Service\IGrossToNetEstimator;
use App\Module\Work\Domain\Entity\Job;
use App\Module\Work\Domain\Entity\TimeEntry;
use App\Module\Work\Domain\Entity\WorkPlanEntry;

final class WorkTimeCalculator
{
    public function __construct(private readonly IGrossToNetEstimator $netEstimator)
    {
    }

    public function segmentMinutes(\DateTimeImmutable $start, \DateTimeImmutable $end): int
    {
        $startMin = ((int) $start->format('H')) * 60 + (int) $start->format('i');
        $endMin = ((int) $end->format('H')) * 60 + (int) $end->format('i');
        if (0 === $endMin && $startMin > 0) {
            $endMin = 24 * 60; // minuit = fin de journée
        }

        return max(0, $endMin - $startMin);
    }

    /**
     * @param iterable<\App\Module\Work\Domain\Entity\TimeSegment|\App\Module\Work\Domain\Entity\WorkPlanSegment> $segments
     */
    public function minutesFromSegments(iterable $segments, int $pauseMinutes, ?int $override = null): int
    {
        if (null !== $override) {
            return max(0, $override);
        }

        $gross = 0;
        foreach ($segments as $segment) {
            $gross += $this->segmentMinutes($segment->getStartTime(), $segment->getEndTime());
        }

        return max(0, $gross - $pauseMinutes);
    }

    public function workedMinutes(TimeEntry $entry): int
    {
        return $this->minutesFromSegments(
            $entry->getSegments(),
            $entry->getPauseMinutes(),
            $entry->getWorkedMinutesOverride(),
        );
    }

    public function plannedMinutes(WorkPlanEntry $entry): int
    {
        return $this->minutesFromSegments($entry->getSegments(), $entry->getPauseMinutes());
    }

    /**
     * @param list<TimeEntry> $entries
     *
     * @return array{
     *   workedMinutes: int,
     *   contractWeeklyMinutes: int,
     *   regularMinutes: int,
     *   overtimeMinutes: int,
     *   overtime1Minutes: int,
     *   overtime2Minutes: int,
     *   estimatedGrossCents: int,
     *   estimatedNetBeforeTaxCents: int,
     *   estimatedPasCents: int,
     *   estimatedFixedDeductionsCents: int,
     *   estimatedNetPayableCents: int,
     *   employeeContributionRateBps: int,
     *   pasRateBps: int
     * }
     */
    public function summarize(Job $job, array $entries, ?int $periodDays = null): array
    {
        $worked = 0;
        foreach ($entries as $entry) {
            $worked += $this->workedMinutes($entry);
        }

        $contract = max(0, $job->getContractWeeklyMinutes());
        // Pour une période arbitraire, le « contrat » de référence reste hebdo ;
        // les stats semaine passent le contrat tel quel ; pour un mois on multiplie côté manager.
        $overtime = max(0, $worked - $contract);
        $regular = $worked - $overtime;

        $threshold = $job->getOvertimeThresholdWeeklyMinutes();
        $ot1 = $overtime;
        $ot2 = 0;
        if (null !== $threshold && $threshold > $contract && $worked > $threshold) {
            $ot1 = max(0, $threshold - $contract);
            $ot2 = max(0, $worked - $threshold);
        }

        $hourly = max(0, $job->getGrossHourlyRateCents());
        $rate1 = max(0, $job->getOvertimeRateBps());
        $rate2 = $job->getOvertimeRate2Bps() ?? $rate1;

        $gross = (int) round($regular * $hourly / 60)
            + (int) round($ot1 * $hourly * $rate1 / 60 / 10000)
            + (int) round($ot2 * $hourly * $rate2 / 60 / 10000);

        $fixed = $this->proratedFixedDeductions($job, $periodDays);
        $net = $this->netEstimator->estimateFromGross($job, $gross, $fixed);

        return [
            'workedMinutes'                 => $worked,
            'contractWeeklyMinutes'         => $contract,
            'regularMinutes'                => $regular,
            'overtimeMinutes'               => $overtime,
            'overtime1Minutes'              => $ot1,
            'overtime2Minutes'              => $ot2,
            'estimatedGrossCents'           => $net['estimatedGrossCents'],
            'estimatedNetBeforeTaxCents'    => $net['estimatedNetBeforeTaxCents'],
            'estimatedPasCents'             => $net['estimatedPasCents'],
            'estimatedFixedDeductionsCents' => $net['estimatedFixedDeductionsCents'],
            'estimatedNetPayableCents'      => $net['estimatedNetPayableCents'],
            'employeeContributionRateBps'   => $net['employeeContributionRateBps'],
            'pasRateBps'                    => $net['pasRateBps'],
        ];
    }

    /**
     * Same as summarize but with an explicit contract budget for the period (e.g. month ≈ weeks * weekly).
     *
     * @param list<TimeEntry> $entries
     *
     * @return array<string, int>
     */
    public function summarizeWithContractBudget(
        Job $job,
        array $entries,
        int $contractBudgetMinutes,
        ?int $periodDays = null,
    ): array {
        $worked = 0;
        foreach ($entries as $entry) {
            $worked += $this->workedMinutes($entry);
        }

        return $this->summarizeTotalMinutes($job, $worked, $contractBudgetMinutes, $periodDays);
    }

    /**
     * @param list<WorkPlanEntry> $entries
     *
     * @return array<string, int>
     */
    public function summarizePlanWithContractBudget(
        Job $job,
        array $entries,
        int $contractBudgetMinutes,
        ?int $periodDays = null,
    ): array {
        $planned = 0;
        foreach ($entries as $entry) {
            $planned += $this->plannedMinutes($entry);
        }

        return $this->summarizeTotalMinutes($job, $planned, $contractBudgetMinutes, $periodDays);
    }

    /**
     * @return array<string, int>
     */
    public function summarizeTotalMinutes(
        Job $job,
        int $worked,
        int $contractBudgetMinutes,
        ?int $periodDays = null,
    ): array {
        $contract = max(0, $contractBudgetMinutes);
        $worked = max(0, $worked);
        $overtime = max(0, $worked - $contract);
        $regular = $worked - $overtime;

        $weeklyContract = max(0, $job->getContractWeeklyMinutes());
        $thresholdWeekly = $job->getOvertimeThresholdWeeklyMinutes();
        $ot1 = $overtime;
        $ot2 = 0;
        if (null !== $thresholdWeekly && $thresholdWeekly > $weeklyContract && $weeklyContract > 0) {
            $extraBand = $thresholdWeekly - $weeklyContract;
            $ratio = $contract / $weeklyContract;
            $periodThreshold = (int) round($weeklyContract * $ratio) + (int) round($extraBand * $ratio);
            if ($worked > $periodThreshold) {
                $ot1 = max(0, $periodThreshold - $contract);
                $ot2 = max(0, $worked - $periodThreshold);
            }
        }

        $hourly = max(0, $job->getGrossHourlyRateCents());
        $rate1 = max(0, $job->getOvertimeRateBps());
        $rate2 = $job->getOvertimeRate2Bps() ?? $rate1;

        $gross = (int) round($regular * $hourly / 60)
            + (int) round($ot1 * $hourly * $rate1 / 60 / 10000)
            + (int) round($ot2 * $hourly * $rate2 / 60 / 10000);

        $fixed = $this->proratedFixedDeductions($job, $periodDays);
        $net = $this->netEstimator->estimateFromGross($job, $gross, $fixed);

        return [
            'workedMinutes'                 => $worked,
            'contractMinutes'               => $contract,
            'regularMinutes'                => $regular,
            'overtimeMinutes'               => $overtime,
            'overtime1Minutes'              => $ot1,
            'overtime2Minutes'              => $ot2,
            'estimatedGrossCents'           => $net['estimatedGrossCents'],
            'estimatedNetBeforeTaxCents'    => $net['estimatedNetBeforeTaxCents'],
            'estimatedPasCents'             => $net['estimatedPasCents'],
            'estimatedFixedDeductionsCents' => $net['estimatedFixedDeductionsCents'],
            'estimatedNetPayableCents'      => $net['estimatedNetPayableCents'],
            'employeeContributionRateBps'   => $net['employeeContributionRateBps'],
            'pasRateBps'                    => $net['pasRateBps'],
        ];
    }

    /**
     * Retenues mensuelles (mutuelle, prévoyance, autres) proratisées sur la période
     * (base 30 jours, plafonnée à un mois).
     */
    private function proratedFixedDeductions(Job $job, ?int $periodDays): int
    {
        $monthly = $job->getMonthlyFixedDeductionsCents();
        if ($monthly <= 0 || null === $periodDays || $periodDays <= 0) {
            return 0;
        }

        return (int) round($monthly * min(1.0, $periodDays / 30));
    }

    /**
     * @return array{0: \DateTimeImmutable, 1: \DateTimeImmutable}
     */
    public function monthBounds(string $yearMonth): array
    {
        if (1 !== preg_match('/^\d{4}-\d{2}$/', $yearMonth)) {
            throw new \InvalidArgumentException('yearMonth doit être YYYY-MM.');
        }
        $start = \DateTimeImmutable::createFromFormat('Y-m-d', $yearMonth.'-01');
        if (false === $start) {
            throw new \InvalidArgumentException('yearMonth invalide.');
        }
        $start = $start->setTime(0, 0);
        $end = $start->modify('last day of this month');

        return [$start, $end];
    }

    /** Index 0 = lundi … 6 = dimanche (aligné sur workDaysMask / weekTemplate). */
    public function mondayBasedBit(\DateTimeImmutable $date): int
    {
        $dow = (int) $date->format('w'); // 0=dim

        return 0 === $dow ? 6 : $dow - 1;
    }

    public function isWorkDay(Job $job, \DateTimeImmutable $date): bool
    {
        $bit = $this->mondayBasedBit($date);

        return (bool) ($job->getWorkDaysMask() & (1 << $bit));
    }

    /**
     * @return array{0: \DateTimeImmutable, 1: \DateTimeImmutable}
     */
    public function weekBounds(\DateTimeImmutable $date, int $weekStartsOn): array
    {
        $weekStartsOn = max(0, min(6, $weekStartsOn));
        $dow = (int) $date->format('w'); // 0=dim … 6=sam
        $delta = ($dow - $weekStartsOn + 7) % 7;
        $start = $date->modify(\sprintf('-%d days', $delta))->setTime(0, 0);
        $end = $start->modify('+6 days');

        return [$start, $end];
    }
}
