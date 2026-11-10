<?php

declare(strict_types=1);

namespace App\Module\Work\Service;

use App\Module\Work\Domain\Entity\Job;
use App\Module\Work\Domain\Entity\TimeEntry;
use Dompdf\Dompdf;
use Dompdf\Options;

/**
 * Génère une feuille d'heures mensuelle (PDF) calquée sur le modèle employeur.
 *
 * Convention : segments[0] = matin, segments[1] = après-midi.
 */
final class TimesheetPdfGenerator
{
    private const WEEKDAYS = [
        0 => 'dimanche',
        1 => 'lundi',
        2 => 'mardi',
        3 => 'mercredi',
        4 => 'jeudi',
        5 => 'vendredi',
        6 => 'samedi',
    ];

    private const MONTHS = [
        1  => 'janvier',
        2  => 'février',
        3  => 'mars',
        4  => 'avril',
        5  => 'mai',
        6  => 'juin',
        7  => 'juillet',
        8  => 'août',
        9  => 'septembre',
        10 => 'octobre',
        11 => 'novembre',
        12 => 'décembre',
    ];

    public function __construct(
        private readonly WorkTimeCalculator $calculator,
        private readonly FrenchPublicHolidays $holidays,
    ) {
    }

    /**
     * @param list<TimeEntry> $entries
     *
     * @return array{binary: string, filename: string}
     */
    public function generate(Job $job, string $yearMonth, array $entries): array
    {
        [$start, $end] = $this->calculator->monthBounds($yearMonth);
        $byDate = [];
        foreach ($entries as $entry) {
            $byDate[$entry->getWorkDate()->format('Y-m-d')] = $entry;
        }

        $worker = $job->getWorker();
        $lastName = $worker->getLastName();
        $firstName = $worker->getFirstName();
        $fullName = $worker->getFullName();

        $year = (int) $start->format('Y');
        $month = (int) $start->format('n');
        $monthLabel = mb_strtoupper(self::MONTHS[$month], 'UTF-8');

        $rowsHtml = '';
        $monthTotalMinutes = 0;
        for ($day = $start; $day <= $end; $day = $day->modify('+1 day')) {
            $key = $day->format('Y-m-d');
            $entry = $byDate[$key] ?? null;
            $isSunday = 0 === (int) $day->format('w');
            $isHoliday = $this->holidays->isHoliday($day);
            $dateLabel = $this->formatDateLabel($day);

            $morningStart = '';
            $morningEnd = '';
            $morningTotal = '';
            $afternoonStart = '';
            $afternoonEnd = '';
            $afternoonTotal = '';
            $pause = '';
            $dayTotal = '';
            $hasMorning = false;
            $hasAfternoon = false;

            if (null !== $entry) {
                $segments = [];
                foreach ($entry->getSegments() as $segment) {
                    $segments[] = $segment;
                }
                if (isset($segments[0])) {
                    $hasMorning = true;
                    $morningStart = $segments[0]->getStartTime()->format('H:i');
                    $morningEnd = $segments[0]->getEndTime()->format('H:i');
                    $morningTotal = $this->formatMinutes(
                        $this->calculator->segmentMinutes($segments[0]->getStartTime(), $segments[0]->getEndTime()),
                    );
                }
                if (isset($segments[1])) {
                    $hasAfternoon = true;
                    $afternoonStart = $segments[1]->getStartTime()->format('H:i');
                    $afternoonEnd = $segments[1]->getEndTime()->format('H:i');
                    $afternoonTotal = $this->formatMinutes(
                        $this->calculator->segmentMinutes($segments[1]->getStartTime(), $segments[1]->getEndTime()),
                    );
                }
                $pauseMinutes = $entry->getPauseMinutes();
                $pause = $pauseMinutes > 0 ? $this->formatMinutes($pauseMinutes) : '';
                $worked = $this->calculator->workedMinutes($entry);
                $dayTotal = $this->formatMinutes($worked);
                $monthTotalMinutes += $worked;
            }

            $emptyDay = !$hasMorning && !$hasAfternoon;
            $amEmpty = !$emptyDay && !$hasMorning;
            $pmEmpty = !$emptyDay && !$hasAfternoon;

            $rowClasses = ['day'];
            if ($isSunday) {
                $rowClasses[] = 'sunday';
            }
            if ($emptyDay) {
                $rowClasses[] = 'empty-day';
            }

            $dateClasses = ['date'];
            if ($isHoliday) {
                $dateClasses[] = 'holiday';
            }

            $rowsHtml .= \sprintf(
                '<tr class="%s">'
                .'<td class="%s">%s</td>'
                .'%s%s%s'
                .'%s%s%s'
                .'%s%s'
                .'</tr>',
                implode(' ', $rowClasses),
                implode(' ', $dateClasses),
                $this->e($dateLabel),
                $this->filledCell($morningStart, $amEmpty),
                $this->filledCell($morningEnd, $amEmpty),
                $this->filledCell($morningTotal, $amEmpty, true),
                $this->filledCell($afternoonStart, $pmEmpty),
                $this->filledCell($afternoonEnd, $pmEmpty),
                $this->filledCell($afternoonTotal, $pmEmpty, true),
                $this->filledCell($pause, false, true),
                $this->filledCell($dayTotal, false, true),
            );
        }

        $daysInMonth = (int) $end->format('j');
        $html = $this->renderHtml(
            year: $year,
            lastName: $lastName,
            firstName: $firstName,
            monthLabel: $monthLabel,
            rowsHtml: $rowsHtml,
            monthTotalLabel: $this->formatMinutes($monthTotalMinutes),
            daysInMonth: $daysInMonth,
        );

        $slug = $this->slugify($fullName);
        $filename = \sprintf('feuille-heures-%s%s.pdf', $yearMonth, '' !== $slug ? '-'.$slug : '');

        return ['binary' => $this->renderPdf($html), 'filename' => $filename];
    }

    /**
     * Feuille de pointage vierge (grille Jour / matin / après-midi / Pauses / Commentaire).
     *
     * @return array{binary: string, filename: string}
     */
    public function generateBlank(string $yearMonth): array
    {
        [$start, $end] = $this->calculator->monthBounds($yearMonth);
        $month = (int) $start->format('n');
        $monthLabel = mb_strtoupper(self::MONTHS[$month], 'UTF-8');
        $daysInMonth = (int) $end->format('j');

        $rowsHtml = '';
        $rowIndex = 0;
        for ($day = $start; $day <= $end; $day = $day->modify('+1 day')) {
            $dow = (int) $day->format('w'); // 0=dim … 6=sam
            $classes = [match ($dow) {
                0       => 'sunday',
                6       => 'saturday',
                default => 'weekday',
            }];
            if (0 === $rowIndex % 2) {
                $classes[] = 'stripe';
            }
            ++$rowIndex;
            $rowsHtml .= \sprintf(
                '<tr class="%s">'
                .'<td class="jour">%s</td>'
                .'<td class="arr"></td><td class="dep"></td>'
                .'<td class="arr pm"></td><td class="dep pm"></td>'
                .'<td class="pause"></td>'
                .'<td class="comment"></td>'
                .'</tr>',
                implode(' ', $classes),
                $this->e($this->formatBlankDayLabel($day)),
            );
        }

        $html = $this->renderBlankHtml($monthLabel, $rowsHtml, $daysInMonth);
        $binary = $this->renderPdf($html, 'landscape');
        $filename = \sprintf('pointage-vierge-%s.pdf', $yearMonth);

        return ['binary' => $binary, 'filename' => $filename];
    }

    public function formatMinutes(int $minutes): string
    {
        $minutes = max(0, $minutes);
        $hours = intdiv($minutes, 60);
        $mins = $minutes % 60;

        return \sprintf('%d:%02d', $hours, $mins);
    }

    public function formatDateLabel(\DateTimeImmutable $date): string
    {
        $weekday = self::WEEKDAYS[(int) $date->format('w')];
        $month = self::MONTHS[(int) $date->format('n')];

        return \sprintf('%s %d %s %s', $weekday, (int) $date->format('j'), $month, $date->format('Y'));
    }

    /** Ex. « Mardi 1er », « Mercredi 2 ». */
    public function formatBlankDayLabel(\DateTimeImmutable $date): string
    {
        $weekday = self::WEEKDAYS[(int) $date->format('w')];
        $weekday = mb_strtoupper(mb_substr($weekday, 0, 1, 'UTF-8'), 'UTF-8').mb_substr($weekday, 1, null, 'UTF-8');
        $day = (int) $date->format('j');
        if (1 === $day) {
            return \sprintf('%s 1er', $weekday);
        }

        return \sprintf('%s %d', $weekday, $day);
    }

    private function renderHtml(
        int $year,
        string $lastName,
        string $firstName,
        string $monthLabel,
        string $rowsHtml,
        string $monthTotalLabel,
        int $daysInMonth,
    ): string {
        $title = $this->e(\sprintf("FEUILLE D'HEURES %d", $year));
        $lastName = $this->e($lastName);
        $firstName = $this->e($firstName);
        $monthLabel = $this->e($monthLabel);
        $monthTotalLabel = $this->e($monthTotalLabel);
        // Remplit la page A4 tout en restant sur 1 page (marges + en-tête + pied).
        $rowHeight = match (true) {
            $daysInMonth >= 31  => '16.2pt',
            30 === $daysInMonth => '16.8pt',
            29 === $daysInMonth => '17.4pt',
            default             => '18.2pt',
        };

        return <<<HTML
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 7mm 6mm 6mm 6mm; }
  body {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 8.5pt;
    color: #111;
    margin: 0;
  }
  .title {
    text-align: center;
    background: #e8c4b8;
    border: 1pt solid #111;
    padding: 2px 6px;
    font-weight: bold;
    font-size: 10.5pt;
    letter-spacing: 0.3px;
    margin: 0 0 5px;
    width: 100%;
    box-sizing: border-box;
  }
  .meta {
    margin: 0 0 3px;
    font-size: 8pt;
    line-height: 1.35;
  }
  .month {
    text-align: center;
    font-weight: bold;
    font-size: 11pt;
    margin: 1px 0 3px;
    text-transform: uppercase;
  }
  table.sheet {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  /* Dompdf ignore souvent colgroup dès qu’il y a colspan/rowspan :
     une ligne fantôme à 9 cellules fixe les largeurs correctement. */
  table.sheet tr.cols td {
    border: none !important;
    padding: 0 !important;
    height: 0 !important;
    line-height: 0 !important;
    font-size: 0 !important;
    overflow: hidden;
  }
  table.sheet th,
  table.sheet td {
    border: 0.6pt solid #111;
    padding: 1px 2px;
    vertical-align: middle;
    text-align: center;
    height: {$rowHeight};
    overflow: hidden;
  }
  table.sheet th {
    font-size: 6.5pt;
    font-weight: bold;
    background: #fff;
    height: 11pt;
    line-height: 1.15;
  }
  table.sheet th.group {
    font-size: 7.5pt;
    height: 10pt;
  }
  table.sheet th.date,
  table.sheet td.date {
    text-align: left;
    font-size: 7.5pt;
    white-space: nowrap;
    padding-left: 3px;
    padding-right: 2px;
    background: #fff !important;
    color: #111;
  }
  table.sheet td.num {
    font-variant-numeric: tabular-nums;
    font-size: 8pt;
  }
  table.sheet td.date.holiday {
    color: #c1121f !important;
    font-weight: bold;
  }
  table.sheet tr.empty-day td:not(.date) {
    background: #cfcfcf;
  }
  table.sheet td.empty {
    background: #cfcfcf;
  }
  table.sheet tr.sunday td {
    background: #2f2f2f;
    color: #fff;
  }
  table.sheet tr.sunday td.date {
    background: #fff !important;
    color: #111;
  }
  table.sheet tr.sunday td.date.holiday {
    color: #c1121f !important;
  }
  .footer {
    margin-top: 4px;
    width: 100%;
  }
  .footer-table {
    border-collapse: collapse;
    margin-left: auto;
  }
  .footer-table td {
    border: 0.8pt solid #111;
    padding: 3px 10px;
    font-size: 9pt;
    font-weight: bold;
  }
  .footer-table .label,
  .footer-table .value {
    color: #c1121f;
    text-align: center;
  }
  .footer-table .value {
    min-width: 42px;
  }
</style>
</head>
<body>
  <div class="title">{$title}</div>
  <div class="meta">
    Nom de l'employé : {$lastName}<br>
    Prénom de l'employé : {$firstName}
  </div>
  <div class="month">{$monthLabel}</div>
  <table class="sheet">
    <tbody>
      <tr class="cols">
        <td width="26%" style="width:26%"></td>
        <td width="9.5%" style="width:9.5%"></td>
        <td width="9.5%" style="width:9.5%"></td>
        <td width="9%" style="width:9%"></td>
        <td width="9.5%" style="width:9.5%"></td>
        <td width="9.5%" style="width:9.5%"></td>
        <td width="9%" style="width:9%"></td>
        <td width="8%" style="width:8%"></td>
        <td width="9.5%" style="width:9.5%"></td>
      </tr>
      <tr>
        <th class="date" rowspan="2" width="26%">DATE</th>
        <th class="group" colspan="2">MATIN</th>
        <th rowspan="2">TOTAL<br>MATIN</th>
        <th class="group" colspan="2">APRES MIDI</th>
        <th rowspan="2">TOTAL<br>APRES MIDI</th>
        <th rowspan="2">PAUSE</th>
        <th rowspan="2">TOTAL</th>
      </tr>
      <tr>
        <th>HEURE<br>D'ARRIVEE</th>
        <th>HEURE DE<br>DEPART</th>
        <th>HEURE<br>D'ARRIVEE</th>
        <th>HEURE DE<br>DEPART</th>
      </tr>
      {$rowsHtml}
    </tbody>
  </table>
  <div class="footer">
    <table class="footer-table">
      <tr>
        <td class="label">TOTAL HEURES</td>
       <td class="value"> <!-- {$monthTotalLabel} --></td>
      </tr>
    </table>
  </div>
</body>
</html>
HTML;
    }

    private function renderBlankHtml(string $monthLabel, string $rowsHtml, int $daysInMonth): string
    {
        $monthLabel = $this->e($monthLabel);
        $verticalMonth = $this->verticalMonthHtml($monthLabel);
        // A4 paysage : hauteur utile plus faible → lignes plus compactes.
        $rowHeight = match (true) {
            $daysInMonth >= 31  => '13.2pt',
            30 === $daysInMonth => '13.8pt',
            29 === $daysInMonth => '14.3pt',
            default             => '15pt',
        };

        return <<<HTML
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  @page { margin: 6mm 8mm 6mm 6mm; }
  body {
    font-family: "DejaVu Sans", sans-serif;
    font-size: 9pt;
    color: #111;
    margin: 0;
  }
  .layout {
    width: 100%;
    border-collapse: collapse;
  }
  .layout td {
    border: none;
    padding: 0;
    vertical-align: middle;
  }
  .layout td.main {
    width: 96%;
  }
  .layout td.month-side {
    width: 4%;
    text-align: center;
    font-weight: bold;
    font-size: 14pt;
    letter-spacing: 3px;
    /* Dompdf : empile les lettres pour un titre vertical à droite */
    line-height: 1.15;
  }
  table.sheet {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }
  table.sheet tr.cols td {
    border: none !important;
    padding: 0 !important;
    height: 0 !important;
    line-height: 0 !important;
    font-size: 0 !important;
    overflow: hidden;
  }
  table.sheet th,
  table.sheet td {
    border: 0.7pt solid #111;
    padding: 1px 3px;
    vertical-align: middle;
    text-align: center;
    height: {$rowHeight};
    overflow: hidden;
  }
  table.sheet th {
    font-size: 9pt;
    font-weight: bold;
    background: #fff;
    height: 11pt;
  }
  table.sheet th.group {
    font-size: 10pt;
    height: 10pt;
  }
  table.sheet th.sub {
    font-size: 8pt;
    font-weight: normal;
    height: 10pt;
  }
  table.sheet td.jour {
    text-align: left;
    font-size: 9pt;
    white-space: nowrap;
    padding-left: 4px;
    background: #fff !important;
    color: #111 !important;
  }
  /* Trait pointillé entre arrivée / départ */
  table.sheet th.arr,
  table.sheet td.arr {
    border-right-style: dashed;
    border-right-width: 0.6pt;
  }
  table.sheet tr.stripe td {
    background: #f2f2f2;
  }
  table.sheet tr.saturday td {
    background: #cfcfcf;
  }
  table.sheet tr.saturday td.pm {
    background: #3a3a3a;
  }
  table.sheet tr.sunday td {
    background: #2a2a2a;
    color: #fff;
  }
  table.sheet tr.stripe td.jour,
  table.sheet tr.saturday td.jour,
  table.sheet tr.sunday td.jour {
    background: #fff !important;
    color: #111 !important;
  }
</style>
</head>
<body>
  <table class="layout">
    <tr>
      <td class="main">
        <table class="sheet">
          <tbody>
            <tr class="cols">
              <td width="14%" style="width:14%"></td>
              <td width="8%" style="width:8%"></td>
              <td width="8%" style="width:8%"></td>
              <td width="8%" style="width:8%"></td>
              <td width="8%" style="width:8%"></td>
              <td width="9%" style="width:9%"></td>
              <td width="45%" style="width:45%"></td>
            </tr>
            <tr>
              <th class="jour" rowspan="2" width="14%">Jour</th>
              <th class="group" colspan="2">matin</th>
              <th class="group" colspan="2">après-midi</th>
              <th rowspan="2">Pauses</th>
              <th rowspan="2">Commentaire</th>
            </tr>
            <tr>
              <th class="sub arr">arrivée</th>
              <th class="sub dep">départ</th>
              <th class="sub arr">arrivée</th>
              <th class="sub dep">départ</th>
            </tr>
            {$rowsHtml}
          </tbody>
        </table>
      </td>
      <td class="month-side">{$verticalMonth}</td>
    </tr>
  </table>
</body>
</html>
HTML;
    }

    /** Affiche le mois en lettres empilées (titre vertical à droite, paysage). */
    private function verticalMonthHtml(string $escapedMonthLabel): string
    {
        $chars = preg_split('//u', $escapedMonthLabel, -1, \PREG_SPLIT_NO_EMPTY) ?: [];
        $parts = [];
        foreach ($chars as $char) {
            if (' ' === $char) {
                $parts[] = '<br><br>';
                continue;
            }
            $parts[] = $char.'<br>';
        }

        return implode('', $parts);
    }

    private function renderPdf(string $html, string $orientation = 'portrait'): string
    {
        $options = new Options();
        $options->set('isRemoteEnabled', false);
        $options->set('defaultFont', 'DejaVu Sans');
        $options->setChroot(\dirname(__DIR__, 4));

        $dompdf = new Dompdf($options);
        $dompdf->loadHtml($html, 'UTF-8');
        $dompdf->setPaper('A4', $orientation);
        $dompdf->render();

        $binary = $dompdf->output();
        if ('' === $binary) {
            throw new \RuntimeException('La génération du PDF a échoué.');
        }

        return $binary;
    }

    private function filledCell(string $value, bool $empty, bool $numeric = false): string
    {
        $classes = [];
        if ($numeric) {
            $classes[] = 'num';
        }
        if ($empty) {
            $classes[] = 'empty';
        }
        $classAttr = [] === $classes ? '' : ' class="'.implode(' ', $classes).'"';

        return \sprintf('<td%s>%s</td>', $classAttr, $this->e($value));
    }

    private function e(string $value): string
    {
        return htmlspecialchars($value, \ENT_QUOTES | \ENT_SUBSTITUTE, 'UTF-8');
    }

    private function slugify(string $value): string
    {
        $value = iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $value);
        if (false === $value) {
            $value = '';
        }
        $value = strtolower($value);
        $value = preg_replace('/[^a-z0-9]+/', '-', $value) ?? '';

        return trim($value, '-');
    }
}
