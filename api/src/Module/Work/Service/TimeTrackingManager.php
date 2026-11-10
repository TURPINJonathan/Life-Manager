<?php

declare(strict_types=1);

namespace App\Module\Work\Service;

use App\Module\Security\Contract\Service\ICurrentUserAccessor;
use App\Module\Work\Domain\Entity\Job;
use App\Module\Work\Domain\Entity\TimeEntry;
use App\Module\Work\Domain\Entity\TimeSegment;
use App\Module\Work\Domain\Entity\TimeShortcut;
use App\Module\Work\Exception\InvalidWorkException;
use App\Module\Work\Exception\TimeEntryNotFoundException;
use App\Module\Work\Exception\TimeShortcutNotFoundException;
use App\Module\Work\Repository\TimeEntryRepository;
use App\Module\Work\Repository\TimeShortcutRepository;
use App\Module\Work\Repository\WorkPlanEntryRepository;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Uid\Uuid;

final class TimeTrackingManager
{
    public function __construct(
        private readonly TimeEntryRepository $entries,
        private readonly TimeShortcutRepository $shortcuts,
        private readonly WorkPlanEntryRepository $plans,
        private readonly JobManager $jobs,
        private readonly WorkTimeCalculator $calculator,
        private readonly WorkScheduleSupport $schedule,
        private readonly TimesheetPdfGenerator $timesheetPdf,
        private readonly ICurrentUserAccessor $users,
    ) {
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listEntries(string $jobId, string $from, string $to): array
    {
        $job = $this->jobs->requireJob($jobId);
        $fromDate = $this->schedule->parseDate($from, 'from');
        $toDate = $this->schedule->parseDate($to, 'to');
        if ($fromDate > $toDate) {
            throw new InvalidWorkException('"from" doit être antérieur ou égal à "to".');
        }

        $result = [];
        foreach ($this->entries->listForJobBetween($job, $fromDate, $toDate) as $entry) {
            $result[] = $this->serializeEntry($entry);
        }

        return $result;
    }

    /**
     * @param array{
     *   workDate: string,
     *   segments: list<array{start: string, end: string}>,
     *   pauseMinutes?: int,
     *   notes?: ?string,
     *   workedMinutesOverride?: ?int
     * } $data
     *
     * @return array<string, mixed>
     */
    public function upsertEntry(string $jobId, array $data): array
    {
        $job = $this->jobs->requireJob($jobId);
        if (!$job->isTimeTrackingEnabled()) {
            throw new InvalidWorkException('Le pointage est désactivé pour cet emploi.');
        }

        $workDate = $this->schedule->parseDate($data['workDate'], 'workDate');
        $entry = $this->entries->findForJobAndDate($job, $workDate) ?? new TimeEntry($job, $workDate);
        $entry->setPauseMinutes(isset($data['pauseMinutes']) ? (int) $data['pauseMinutes'] : 0);
        if (\array_key_exists('notes', $data)) {
            $entry->setNotes(null === $data['notes'] ? null : (string) $data['notes']);
        }
        if (\array_key_exists('workedMinutesOverride', $data)) {
            $entry->setWorkedMinutesOverride(
                null === $data['workedMinutesOverride'] ? null : (int) $data['workedMinutesOverride'],
            );
        }

        $entry->clearSegments();
        $segments = $this->schedule->normalizeSegments($data['segments']);
        foreach ($segments as $i => $seg) {
            $entry->addSegment(new TimeSegment(
                $entry,
                $this->schedule->parseTime($seg['start'], 'start'),
                $this->schedule->parseTime($seg['end'], 'end'),
                $i,
            ));
        }

        $this->entries->save($entry);

        return $this->serializeEntry($entry);
    }

    /**
     * @param array<string, mixed> $data
     *
     * @return array<string, mixed>
     */
    public function updateEntry(string $id, array $data): array
    {
        $entry = $this->requireEntry($id);
        if (isset($data['workDate'])) {
            $newDate = $this->schedule->parseDate($data['workDate'], 'workDate');
            $existing = $this->entries->findForJobAndDate($entry->getJob(), $newDate);
            if (null !== $existing && !$existing->getId()->equals($entry->getId())) {
                throw new InvalidWorkException('Un pointage existe déjà pour cette date.');
            }
            $entry->setWorkDate($newDate);
        }
        if (isset($data['pauseMinutes'])) {
            $entry->setPauseMinutes((int) $data['pauseMinutes']);
        }
        if (\array_key_exists('notes', $data)) {
            $entry->setNotes(null === $data['notes'] ? null : (string) $data['notes']);
        }
        if (\array_key_exists('workedMinutesOverride', $data)) {
            $entry->setWorkedMinutesOverride(
                null === $data['workedMinutesOverride'] ? null : (int) $data['workedMinutesOverride'],
            );
        }
        if (isset($data['segments']) && \is_array($data['segments'])) {
            $entry->clearSegments();
            /** @var list<mixed> $rawSegments */
            $rawSegments = array_values($data['segments']);
            $segments = $this->schedule->normalizeSegments($rawSegments);
            foreach ($segments as $i => $seg) {
                $entry->addSegment(new TimeSegment(
                    $entry,
                    $this->schedule->parseTime($seg['start'], 'start'),
                    $this->schedule->parseTime($seg['end'], 'end'),
                    $i,
                ));
            }
        }
        $this->entries->save($entry);

        return $this->serializeEntry($entry);
    }

    public function deleteEntry(string $id): void
    {
        $this->entries->remove($this->requireEntry($id));
    }

    /**
     * @return array<string, mixed>
     */
    public function stats(string $jobId, string $from, string $to): array
    {
        $job = $this->jobs->requireJob($jobId);
        $fromDate = $this->schedule->parseDate($from, 'from');
        $toDate = $this->schedule->parseDate($to, 'to');
        if ($fromDate > $toDate) {
            throw new InvalidWorkException('"from" doit être antérieur ou égal à "to".');
        }

        $entries = $this->entries->listForJobBetween($job, $fromDate, $toDate);
        $planEntries = $this->plans->listForJobBetween($job, $fromDate, $toDate);
        $days = max(1, (int) $fromDate->diff($toDate)->days + 1);
        $weeksApprox = $days / 7;
        $contractBudget = (int) round($job->getContractWeeklyMinutes() * $weeksApprox);

        $actual = $this->calculator->summarizeWithContractBudget($job, $entries, $contractBudget, $days);
        $planned = $this->calculator->summarizePlanWithContractBudget($job, $planEntries, $contractBudget, $days);

        $byDayMap = [];
        for ($d = $fromDate; $d <= $toDate; $d = $d->modify('+1 day')) {
            $key = $d->format('Y-m-d');
            $byDayMap[$key] = [
                'workDate'       => $key,
                'plannedMinutes' => 0,
                'actualMinutes'  => 0,
            ];
        }
        foreach ($planEntries as $entry) {
            $key = $entry->getWorkDate()->format('Y-m-d');
            if (isset($byDayMap[$key])) {
                $byDayMap[$key]['plannedMinutes'] = $this->calculator->plannedMinutes($entry);
            }
        }
        foreach ($entries as $entry) {
            $key = $entry->getWorkDate()->format('Y-m-d');
            if (isset($byDayMap[$key])) {
                $byDayMap[$key]['actualMinutes'] = $this->calculator->workedMinutes($entry);
            }
        }

        $weeks = $this->buildWeeksInRange($job, $fromDate, $toDate);
        $week = [] !== $weeks ? $weeks[\count($weeks) - 1] : $this->buildWeekStats(
            $job,
            ...$this->calculator->weekBounds($toDate, $job->getWeekStartsOn()),
        );

        return [
            'from'    => $fromDate->format('Y-m-d'),
            'to'      => $toDate->format('Y-m-d'),
            'actual'  => $actual,
            'planned' => $planned,
            'period'  => $actual, // rétrocompat
            'week'    => [
                ...$week['actual'],
                'from'    => $week['from'],
                'to'      => $week['to'],
                'actual'  => $week['actual'],
                'planned' => $week['planned'],
            ],
            'weeks'      => $weeks,
            'days'       => array_values($byDayMap),
            'entryCount' => \count($entries),
            'planCount'  => \count($planEntries),
        ];
    }

    /**
     * Semaines calendaires qui intersectent [from, to] (bornes complètes pour les HS).
     *
     * @return list<array<string, mixed>>
     */
    private function buildWeeksInRange(Job $job, \DateTimeImmutable $fromDate, \DateTimeImmutable $toDate): array
    {
        [$cursorStart] = $this->calculator->weekBounds($fromDate, $job->getWeekStartsOn());
        $weeks = [];
        $guard = 0;
        while ($cursorStart <= $toDate && $guard < 12) {
            [$weekStart, $weekEnd] = $this->calculator->weekBounds($cursorStart, $job->getWeekStartsOn());
            $weeks[] = $this->buildWeekStats($job, $weekStart, $weekEnd);
            $cursorStart = $weekEnd->modify('+1 day');
            ++$guard;
        }

        return $weeks;
    }

    /**
     * @return array{
     *   from: string,
     *   to: string,
     *   actual: array<string, int>,
     *   planned: array<string, int>,
     *   legalWeeklyMinutes: int,
     *   contractWeeklyMinutes: int,
     *   actualOvertimeVsLegalMinutes: int,
     *   plannedOvertimeVsLegalMinutes: int,
     *   actualOvertimeVsContractMinutes: int,
     *   plannedOvertimeVsContractMinutes: int
     * }
     */
    private function buildWeekStats(Job $job, \DateTimeImmutable $weekStart, \DateTimeImmutable $weekEnd): array
    {
        $weekEntries = $this->entries->listForJobBetween($job, $weekStart, $weekEnd);
        $weekPlans = $this->plans->listForJobBetween($job, $weekStart, $weekEnd);
        $contractWeekly = $job->getContractWeeklyMinutes();
        $legalWeekly = Job::DEFAULT_WEEKLY_MINUTES;

        $weekActual = $this->calculator->summarizeWithContractBudget($job, $weekEntries, $contractWeekly, 7);
        $weekPlanned = $this->calculator->summarizePlanWithContractBudget($job, $weekPlans, $contractWeekly, 7);

        $actualWorked = (int) $weekActual['workedMinutes'];
        $plannedWorked = (int) $weekPlanned['workedMinutes'];

        return [
            'from'                             => $weekStart->format('Y-m-d'),
            'to'                               => $weekEnd->format('Y-m-d'),
            'actual'                           => $weekActual,
            'planned'                          => $weekPlanned,
            'legalWeeklyMinutes'               => $legalWeekly,
            'contractWeeklyMinutes'            => $contractWeekly,
            'actualOvertimeVsLegalMinutes'     => max(0, $actualWorked - $legalWeekly),
            'plannedOvertimeVsLegalMinutes'    => max(0, $plannedWorked - $legalWeekly),
            'actualOvertimeVsContractMinutes'  => max(0, $actualWorked - $contractWeekly),
            'plannedOvertimeVsContractMinutes' => max(0, $plannedWorked - $contractWeekly),
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listShortcuts(string $jobId): array
    {
        $job = $this->jobs->requireJob($jobId);
        $result = [];
        foreach ($this->shortcuts->listForJob($job) as $shortcut) {
            $result[] = $this->serializeShortcut($shortcut);
        }

        return $result;
    }

    /**
     * @param array{label: string, segments: list<array{start: string, end: string}>, pauseMinutes?: int, position?: int} $data
     *
     * @return array<string, mixed>
     */
    public function createShortcut(string $jobId, array $data): array
    {
        $job = $this->jobs->requireJob($jobId);
        $segments = $this->schedule->normalizeSegments($data['segments']);
        $shortcut = new TimeShortcut(
            $job,
            (string) $data['label'],
            $segments,
            isset($data['pauseMinutes']) ? (int) $data['pauseMinutes'] : 0,
            isset($data['position']) ? (int) $data['position'] : 0,
        );
        $this->shortcuts->save($shortcut);

        return $this->serializeShortcut($shortcut);
    }

    /**
     * @param array<string, mixed> $data
     *
     * @return array<string, mixed>
     */
    public function updateShortcut(string $id, array $data): array
    {
        $shortcut = $this->requireShortcut($id);
        if (isset($data['label'])) {
            $shortcut->setLabel((string) $data['label']);
        }
        if (isset($data['segments']) && \is_array($data['segments'])) {
            /** @var list<mixed> $rawSegments */
            $rawSegments = array_values($data['segments']);
            $shortcut->setSegments($this->schedule->normalizeSegments($rawSegments));
        }
        if (isset($data['pauseMinutes'])) {
            $shortcut->setPauseMinutes((int) $data['pauseMinutes']);
        }
        if (isset($data['position'])) {
            $shortcut->setPosition((int) $data['position']);
        }
        $this->shortcuts->save($shortcut);

        return $this->serializeShortcut($shortcut);
    }

    public function deleteShortcut(string $id): void
    {
        $this->shortcuts->remove($this->requireShortcut($id));
    }

    public function timesheetPdf(string $jobId, string $yearMonth): Response
    {
        $job = $this->jobs->requireJob($jobId);
        try {
            [$from, $to] = $this->calculator->monthBounds($yearMonth);
        } catch (\InvalidArgumentException $e) {
            throw new InvalidWorkException($e->getMessage());
        }

        $entries = $this->entries->listForJobBetween($job, $from, $to);
        $pdf = $this->timesheetPdf->generate($job, $yearMonth, $entries);

        return $this->pdfResponse($pdf);
    }

    public function timesheetBlankPdf(string $jobId, string $yearMonth): Response
    {
        // Ownership du job (même si la grille ne dépend pas des pointages).
        $this->jobs->requireJob($jobId);
        try {
            $this->calculator->monthBounds($yearMonth);
        } catch (\InvalidArgumentException $e) {
            throw new InvalidWorkException($e->getMessage());
        }

        return $this->pdfResponse($this->timesheetPdf->generateBlank($yearMonth));
    }

    /**
     * @param array{binary: string, filename: string} $pdf
     */
    private function pdfResponse(array $pdf): Response
    {
        $response = new Response($pdf['binary'], Response::HTTP_OK, [
            'Content-Type'        => 'application/pdf',
            'Content-Disposition' => \sprintf('inline; filename="%s"', $pdf['filename']),
            'Cache-Control'       => 'private, no-store',
        ]);
        $response->headers->set('Content-Length', (string) \strlen($pdf['binary']));

        return $response;
    }

    private function requireEntry(string $id): TimeEntry
    {
        try {
            $uuid = Uuid::fromString($id);
        } catch (\InvalidArgumentException) {
            throw new TimeEntryNotFoundException();
        }
        $entry = $this->entries->findOwned($uuid, $this->users->requireUser());
        if (null === $entry) {
            throw new TimeEntryNotFoundException();
        }

        return $entry;
    }

    private function requireShortcut(string $id): TimeShortcut
    {
        try {
            $uuid = Uuid::fromString($id);
        } catch (\InvalidArgumentException) {
            throw new TimeShortcutNotFoundException();
        }
        $shortcut = $this->shortcuts->findOwned($uuid, $this->users->requireUser());
        if (null === $shortcut) {
            throw new TimeShortcutNotFoundException();
        }

        return $shortcut;
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeEntry(TimeEntry $entry): array
    {
        $segments = [];
        foreach ($entry->getSegments() as $segment) {
            $segments[] = [
                'id'       => (string) $segment->getId(),
                'start'    => $segment->getStartTime()->format('H:i'),
                'end'      => $segment->getEndTime()->format('H:i'),
                'position' => $segment->getPosition(),
            ];
        }

        return [
            'id'                    => (string) $entry->getId(),
            'jobId'                 => (string) $entry->getJob()->getId(),
            'workDate'              => $entry->getWorkDate()->format('Y-m-d'),
            'pauseMinutes'          => $entry->getPauseMinutes(),
            'workedMinutesOverride' => $entry->getWorkedMinutesOverride(),
            'workedMinutes'         => $this->calculator->workedMinutes($entry),
            'notes'                 => $entry->getNotes(),
            'segments'              => $segments,
            'createdAt'             => $entry->getCreatedAt()->format(\DateTimeInterface::ATOM),
            'updatedAt'             => $entry->getUpdatedAt()->format(\DateTimeInterface::ATOM),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function serializeShortcut(TimeShortcut $shortcut): array
    {
        return [
            'id'           => (string) $shortcut->getId(),
            'jobId'        => (string) $shortcut->getJob()->getId(),
            'label'        => $shortcut->getLabel(),
            'segments'     => $shortcut->getSegments(),
            'pauseMinutes' => $shortcut->getPauseMinutes(),
            'position'     => $shortcut->getPosition(),
        ];
    }
}
