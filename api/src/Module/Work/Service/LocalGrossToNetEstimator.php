<?php

declare(strict_types=1);

namespace App\Module\Work\Service;

use App\Module\Work\Contract\Service\IGrossToNetEstimator;
use App\Module\Work\Domain\Entity\Job;
use App\Module\Work\Domain\Enum\JobStatus;
use Symfony\Component\DependencyInjection\Attribute\AsAlias;

#[AsAlias(IGrossToNetEstimator::class)]
final class LocalGrossToNetEstimator implements IGrossToNetEstimator
{
    public function estimateFromGross(Job $job, int $grossCents, int $fixedDeductionCents = 0): array
    {
        $grossCents = max(0, $grossCents);
        $fixedDeductionCents = max(0, $fixedDeductionCents);
        $contributionBps = max(0, min(10000, $job->getEmployeeContributionRateBps()));
        $pasBps = max(0, min(10000, $job->getPasRateBps()));

        $netBeforeTax = (int) round($grossCents * (10000 - $contributionBps) / 10000);
        $pasCents = (int) round($netBeforeTax * $pasBps / 10000);
        $netPayable = max(0, $netBeforeTax - $pasCents - $fixedDeductionCents);

        return [
            'estimatedGrossCents'           => $grossCents,
            'estimatedNetBeforeTaxCents'    => $netBeforeTax,
            'estimatedPasCents'             => $pasCents,
            'estimatedFixedDeductionsCents' => $fixedDeductionCents,
            'estimatedNetPayableCents'      => $netPayable,
            'employeeContributionRateBps'   => $contributionBps,
            'pasRateBps'                    => $pasBps,
        ];
    }

    public function suggestContributionRate(Job $job, int $sampleGrossCents = 300000): array
    {
        // Valeurs indicatives droit commun (hors spécificités conventionnelles).
        $bps = JobStatus::Cadre === $job->getStatus() ? 2500 : 2200;

        return [
            'employeeContributionRateBps' => $bps,
            'source'                      => 'local_defaults',
            'note'                        => 'Suggestion indicative (cadre ≈ 25 %, non-cadre ≈ 22 %). À ajuster selon votre fiche de paie.',
        ];
    }
}
