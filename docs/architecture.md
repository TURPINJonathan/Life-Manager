# Architecture

Life Manager est un monorepo. L'API et le front se parlent en JSON, sur HTTP, avec un JWT.

## API

Le code métier vit dans `api/src/Module/<Nom>/`. API Platform 5 sert les ressources ; les points techniques restent des contrôleurs.

```
Module/Security/
  Contract/          interfaces injectées
  Domain/Entity      entités Doctrine
  Domain/Enum
  Dto
  Repository         implémentations Doctrine
  Service            cas d'usage
  Provider           lecture pour un endpoint
  Controller         routes HTTP hors ressource API Platform
  Infrastructure     commandes, détails techniques
  Exception
```

Un nouveau sujet (comptes, travail, …) devient un nouveau dossier `Module/`, avec le même découpage, seulement les couches utiles. On n'ajoute pas d'interface s'il n'y a qu'un appelant local et pas de seconde implémentation prévue.

Doctrine mappe explicitement `Domain/Entity`. Les DTO ne sont pas des entités.

API Platform sert les ressources et la doc OpenAPI. Les points d'entrée techniques (`/api/login`, `/api/me`) et les modules métier v1 (`/api/accounts`, `/api/categories`, `/api/workers`, …) restent des contrôleurs Symfony JSON.

## Modules métier (v1)

- **`Module/Security`** — utilisateurs, JWT, `/api/login`, `/api/me`
- **`Module/Category`** — catégories (icône, couleur, kind) scopées à l’utilisateur ; **enseignes liées** (`merchantIds`) et **favori** optionnel (`favoriteMerchantId`, auto si une seule enseigne)
- **`Module/Merchant`** — enseignes (label, couleur, **icône XOR image**) scopées à l’utilisateur ; **catégories liées** (`categoryIds`) ; image stockée sous `var/uploads` (gzip) et servie décompressée via endpoint JWT (`Cache-Control: private, max-age=86400`)
- **`Module/Account`** — comptes → sous-comptes → transactions (`ledger_transaction`), solde en centimes, **forecasts mensuels** (`monthly_forecast` / `forecast_line`) ; enseigne et pièce jointe **optionnelles** sur une opération (photo/PDF sous `var/uploads` en gzip, download JWT décompressé). À la saisie, le choix d’une catégorie préremplit l’enseigne favorite ; le select enseigne liste d’abord les liées. `GET /api/sub-accounts/{id}/transactions?limit=&offset=` renvoie le relevé **plus récent en premier**, avec `hasMore` / `nextOffset` et `balanceAfterCents` cohérents page par page. Avec `categoryId` + `yearMonth` (ensemble), même endpoint filtre par catégorie et mois (`operationDate`), ordre chronologique, sans pagination ni solde courant.
- **`Module/Work`** — travailleurs (`work_worker`) → emplois (`work_job`, dont `week_template` / `work_days_mask`) → documents (`work_document`), **planning** (`work_plan_entry` / `work_plan_segment`), pointages (`work_time_entry` / `work_time_segment`) et raccourcis (`work_time_shortcut`). Plusieurs profils sous l’utilisateur ; temps en minutes, montants en centimes ; estimation nette locale (cotisations + PAS + retenues mensuelles mutuelle / prévoyance / autres, proratisées sur la période) via `IGrossToNetEstimator` ; uploads `work-documents/{ownerId}/`. Endpoints : `/api/workers`, `/api/jobs/{id}`, documents, `time-entries`, `plan-entries` (+ `fill-month` via semaine type), `time-stats` (prévu + réel, `weeks[]` avec HS vs 35h et vs contrat), `GET /api/work-stats/dashboard?yearMonth=`, `GET /api/jobs/{id}/timesheet.pdf?yearMonth=` (feuille d’heures PDF complétée), `GET /api/jobs/{id}/timesheet-blank.pdf?yearMonth=` (pointage vierge ; Jour / matin / après-midi / Pauses / Commentaire), raccourcis, `suggest-contribution-rate`.

Montants absolus à la saisie ; le signe (+ crédit / − débit) est dérivé du type de catégorie (`expense` / `income`). Pour une catégorie `both`, le client envoie aussi `flow`.

### Forecasts

Un budget est **optionnel**, scensé à un sous-compte et à un mois (`YYYY-MM`). Endpoints :

| Méthode | Path |
| --- | --- |
| GET | `/api/sub-accounts/{id}/forecasts?yearMonth=` |
| POST | `/api/sub-accounts/{id}/forecasts` |
| POST | `/api/sub-accounts/{id}/forecasts/duplicate` |
| PATCH/DELETE | `/api/forecasts/{id}` |
| GET | `/api/sub-accounts/{id}/forecast-stats?yearMonth=` |
| GET | `/api/forecast-stats/dashboard?yearMonth=&includePrevious=` |
| GET | `/api/forecast-stats/series?anchor=YYYY-MM&span=calendar\|rolling` |

La duplication copie les lignes d’un mois source vers un mois cible (défaut : mois précédent → mois courant). Les stats exposent soldes (début, actuel, fin réalisée, projetés budget/réaliste), totaux planifiés/réalisés, détail par catégorie et flux hors budget.

Chaque ligne de budget peut porter un **jour du mois optionnel** (`scheduledDay`, 1–31) et un montant : une échéance = une ligne. La même catégorie peut apparaître plusieurs fois (ex. le 3 et le 15 avec des montants différents). Les lignes **sans jour** (date flexible) n’apparaissent pas dans les échéances : leur montant est **lissé** sur la timeline budget / projection, sans barre de catégorie dédiée. La duplication conserve le jour.

Les **stats** exposent aussi une `timeline` jour par jour (`budgetBalanceCents`, `realisticBalanceCents`, `actualBalanceCents`, événements planifiés/réalisés) pour projeter le solde du sous-compte sur le mois. `GET /api/forecast-stats/dashboard` agrège en une seule réponse les stats de tous les sous-comptes actifs (timelines, totaux, catégories) pour le dashboard `/comptes` — graphique en **une trajectoire** (plein jusqu’à aujourd’hui, pointillé ensuite) + budget + overlay M−1, et carte **Échéances** (prochaines lignes planifiées). `GET /api/forecast-stats/series` renvoie une série mensuelle (année civile ou 12 mois glissants) avec totaux, agrégat par catégorie (dont série mensuelle par catégorie) et par sous-compte.

Les montants **réalisés** du forecast (stats, timeline, hors budget) se basent sur la **date d’opération** (`operationDate`), pas sur la date effective. Le **solde confirmé** du compte (`balanceCents`) n’utilise que les opérations pointées (`effectiveDate`) ; le **solde provisoire** (`provisionalBalanceCents`) et les `balanceAfterCents` du ledger incluent aussi les opérations en attente.

À la **création ou modification** d’une opération, si la catégorie (et le sens, si `both`) n’est pas dans le budget du mois de la date d’opération, le budget est **créé si besoin** et une ligne est ajoutée avec un montant planifié de **0 €** et le jour d’opération. La réponse inclut `forecastCategoryAdded` (toast côté front).

L’ouverture des **stats forecast** synchronise aussi les catégories présentes dans les opérations du mois mais absentes du budget (même règle : forecast créé si besoin, ligne à 0 €) — le bloc « hors budget » ne doit plus lister ces catégories.

Les stats exposent aussi un bloc **`previousMonth`** (indicatif) : totaux + catégories présentes en M avec leurs montants M−1, et **`orphans`** (catégories M−1 absentes du budget courant). Ces données n’entrent pas dans les totaux, la timeline ni le solde projeté.

## Front

```
front/app/
  components/     pièces visuelles réutilisables
  constants/      routes, statuts, clés
  hooks/
  layouts/        shell, barre, navigation
  modules/        un dossier par domaine (comptes, travail, …)
  pages/          écrans transverses (accueil, connexion, paramètres)
  routes/         fichiers minces, sans logique
  security/       gardes
  services/       appels HTTP
  store/          état de session
  types/
```

Les routes déclarées dans `app/routes.ts` rendent une page ou un layout. La logique d'accès est dans `security/`, l'appel réseau dans `services/`.

### Titres d’onglet

Chaque route exporte `meta()` avec `appTitle(…)` (`Partie · Life Manager`). Le ledger pose aussi le titre côté client via `useDocumentTitle` (nom du sous-compte + Opérations / Budget).

## Données

Chaque personne a son compte. Les données d'un module futur appartiennent à l’utilisateur connecté. Un foyer ou un espace partagé n'est pas dans ce socle.

Les fichiers uploadés (logos, pièces jointes, documents travail) passent par `LocalUploadStorage` : compression **gzip** à l’écriture sous `var/uploads` (`*.{ext}.gz`), décompression transparente à la lecture HTTP. Sous-dossiers : `transactions/`, `merchants/`, `work-documents/`. Les anciens fichiers non compressés restent servis tels quels.
