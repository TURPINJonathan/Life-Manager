# Front

React 19, React Router 8, Tailwind 4, Zustand, React Hook Form et Zod.

Le shell, la nav et les tokens de design reprennent le modèle FYNX : rail desktop, barre d’onglets mobile avec bouton Créer au centre, top-bar avec titre contextuel et menu compte, Material Symbols, typographie `display` / `title` / `body`, surfaces `bg-page` / `bg-card`.

Les utilities de marque (`bg-accent`, `text-brand`, …) sont les mêmes partout ; seule la **dominance** (valeurs CSS derrière ces tokens) change selon la page.

## Dominance de couleur

### Principe

- Surfaces de base : **neutres** (slate), pas de vert par défaut.
- Chaque section majeure a une teinte (`data-accent` sur `<html>`).
- Les composants ne connaissent que les tokens (`accent`, `brand`, `accent-tint`, …). Ils ne choisissent pas la teinte.

| Clé | Usage | Teinte |
| --- | --- | --- |
| `neutral` | Accueil, login, fallback | Ambre doré |
| `accounts` | `/comptes` (+ sous-routes) | Cyan marin |
| `work` | `/travail` (+ sous-routes) | Vert printemps |
| `settings` | `/parametres` | Bleu |

## Travail

- **`/parametres/travail`** : CRUD travailleurs (prénom / nom) et emplois (contrat, taux, cotisations, PAS, retenues mensuelles mutuelle / prévoyance / autres, HS, pointeuse, **semaine type**) — dialog emploi large, sections Poste / Contrat / Rémunération / Estimation nette — comme `/parametres/comptes`.
- **`/travail`** : dashboard mensuel type Comptes (sélecteur de mois, carte synthèse prévu/réel + brut/net, cartes par personne, timeline heures cumulées, alertes HS / sous-heures). Une alerte ouverte via la cloche est écartée localement tant que sa valeur ne change pas. Structure via engrenage → paramètres.
- **`/travail/:jobId`** : chrome type ledger (toggle **Temps** / Documents, nav mois). Un seul calendrier avec **prévu + réel** par jour ; clic → dialog élargi (prévu et réel côte à côte, copie du prévu dans la barre d’actions). Synthèse mois brut/net prévu+réel ; **par semaine** : heures, brut/net, HS vs 35h et vs contrat. « Remplir » applique la **semaine type** définie dans le paramétrage de l’emploi. Export PDF (bouton) : dialog avec choix **feuille d’heures** / **pointage vierge**, aperçu, téléchargement et impression. Documents : filtre + `ChoiceCards` + confirm. Query `?onglet=` / `?mois=`.

## Comptes, catégories & enseignes

- **`/comptes`** : dashboard en grille 4 colonnes alignées (solde 1 + comptes comptes 1 chacun ; dessous 2+1+1 : graphique, **Échéances**, **Répartition**). Navigation de mois dans le chrome (`?mois=YYYY-MM`, comme le budget d’un sous-compte). Stats via `fetchForecastStatsDashboard` (rechargées à chaque changement de mois) ; soldes des cartes (combiné, comptes, répartition, switcher ledger) : **solde provisoire** pour le mois courant (et fallback live), fin de mois / projection pour les autres mois. Carte **Échéances** : uniquement les lignes avec jour fixé (pas les dates flexibles) ; bouton calendrier en face du titre, dialog large (navigation de mois, échéances dans chaque case, détail au survol, clic → budget de la ligne). Les montants flexibles sont lissés dans la courbe budget, sans barre de catégorie. Cloche **À surveiller** : une alerte ouverte (clic) est écartée localement tant que son montant ne change pas. Toggle **Mois / Année** dans le chrome (`?vue=annee`) : vue annuelle avec navigation par **période** (année civile ou fenêtre de 12 mois), totaux, courbes revenus/dépenses côte à côte + solde (valeurs au survol), liste catégories, graphiques par catégorie, puis cartes colorées par sous-compte.
- **`/comptes/:subAccountId`** : chrome détail épinglé ; toggle compact Opérations / Budget ; budget synchronisé sur `?vue=budget&mois=YYYY-MM` ; actions budget (Modifier / Supprimer) et création opération en haut à droite ; switcher. **Opérations** : `thead` sticky, pagination API (`limit`/`offset`, pages de 50) et chargement de la suite au scroll.
- **Budget** : vue stats toujours visible ; **+** sur Revenus/Dépenses ouvre un dialog (catégorie, montant TPE, jour) ; clic sur une carte → échéances ; bouton reçu → liste des opérations du mois pour la catégorie ; duplication M−1 en en-tête ; vue tableur (dialog) pour édition groupée ; suppression du budget dans le chrome du ledger. Cartes solde : **réalisé / fin estimée / si budget tenu** basés sur la **date d’opération** ; **solde pointé** sur la **date effective**. Graphique combo (même SVG / même axe €) : **trajectoire** + **budget** (+ M−1) et histogrammes catégories ancrés sur **0 €** (revenus vers le haut, dépenses vers le bas ; plan fantôme / réalisé plein ; catégories 100 % flexibles absentes des barres, lissées dans la courbe).
- **Paramètres** : `/parametres` → profil / comptes / catégories / **enseignes** ; rail sections (desktop) + pills (mobile) ; contenu en `SectionCard` ; archivage via `ConfirmDialog`.
- **Opération** : catégorie obligatoire sans préremplissage à la création (création à la volée) ; **enseigne optionnelle** (auto-favori de la catégorie si défini ; select : liées A–Z puis autres A–Z) ; **pièce jointe optionnelle** (caméra ou fichier PDF/image) ; si la catégorie n’est pas dans le budget du mois (date d’opération), une ligne forecast est ajoutée automatiquement. **Montant** : saisie type TPE (`TpeAmountInput`) — chiffres uniquement, virgule implicite (ex. `1` `2` `5` → `1,25 €`), aussi dans l’éditeur de budget.
- **Catégories / enseignes** : liaison N–N ; une enseigne favorite par catégorie (auto si une seule). Images d’enseignes : cache mémoire partagé (`merchant-image-cache`) via `MerchantVisual` — un fetch par enseigne, réutilisé au remontage ; invalidation à l’upload / suppression / logout.
- **Toasts** : `ToastHost` dans `AppShell` ; helpers `toastSuccess` / `toastError` / `toastFromError` / `toastInfo` (`@utils`) pour le feedback. Confirmations destructives via `ConfirmDialog` (pas `window.confirm`).
- **Boutons** : `success` (enregistrer), `successOutline` (enregistrer et continuer), `warning` (modifier), `danger` (supprimer / archiver), `dangerOutline` (annuler), `neutral` (réinitialiser).
- Composants partagés : `ListCard`, `SectionCard`, `EmptyState`, `ConfirmDialog` (tokens `accent`, pas copper FYNX).

## Dominance — fichiers

| Fichier | Rôle |
| --- | --- |
| `front/app/constants/accent.constants.ts` | `APP_ACCENT`, `ROUTE_ACCENT`, `resolveAccent()` |
| `front/app/hooks/use-route-accent.hook.ts` | Pose `document.documentElement.dataset.accent` |
| `front/app/routes/_root.tsx` | Appelle le hook (app + login) |
| `front/app/app.css` | Packs `[data-accent='…']` et variantes dark |

### Ajouter une dominance

1. Ajouter la clé dans `APP_ACCENT`.
2. Mapper le préfixe de route dans `ROUTE_ACCENT`.
3. Copier un bloc `[data-accent='…']` dans `app.css` et ajuster `--accent`, `--brand`, `--accent-tint`, `--bg-page`, alphas, puis le bloc `html.dark[data-accent='…']`.

Modifier une teinte = éditer uniquement le bloc CSS correspondant. Changer la page associée = éditer `ROUTE_ACCENT`.

### Règles

- Pas de hex / classes Tailwind couleur-nommées (`bg-orange-500`) pour la marque dans les composants.
- Le plus long préfixe gagne (`/comptes/nouveau` → `accounts`).
- `/` ne match que l’accueil exact (pas toutes les routes).

## Rayons

Tokens (`app.css`) : `--radius-panel` → `rounded-panel` (cartes / panneaux), `--radius-control` → `rounded-control` (surfaces inset, champs, lignes), `--radius-control-sm` → `rounded-control-sm` (insets denses). Pas de rayons Tailwind bruts (`rounded-2xl`, `rounded-xl`, …) sur les cartes.

Règle d’imbrication : `r_inner = max(0, R_outer − padding)`.

Paires canoniques :

- Carte `rounded-panel` + `p-3` (12px) → enfants bordés en `rounded-control` (12px)
- Carte `rounded-panel` + `p-4` (16px) → enfants bordés en `rounded-control-sm` (8px)
- Wrapper `rounded-control` + `p-2` (8px) → enfants en `rounded-control-sm` (ou sans rayon)
- Ne jamais imbriquer `rounded-panel` dans un autre `rounded-panel` / dialog — utiliser `rounded-control` pour les blocs internes

## Layout

`AppShell` compose `TopBar`, `Nav` (rail + tab), le menu compte (`Dialog`) et la surface principale `APP_MAIN_SURFACE_CLASSES`.

Les entrées de navigation sont dans `NAV_ITEMS` / `MENU_ITEMS` / `CREATE_ENTRIES`.

### Titres d’onglet

`appTitle(…)` dans `meta()` de chaque route (`Partie · Life Manager`). Sur le ledger, `useDocumentTitle` affine avec le nom du sous-compte et la vue (Opérations / Budget).

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement (port 9200) |
| `npm run build` | Build de production |
| `npm run typecheck` | Types React Router + `tsc` |
| `npm run lint` | ESLint (contrôle) |
| `npm run lint:fix` | ESLint (corrige ce qui est auto-fixable) |
| `npm run format` | Prettier (écrit) |
| `npm run format:check` | Prettier (contrôle) |
| `npm run fix` | `format` + `lint:fix` |
| `npm run check` | `format:check` + `lint` |
| `npm test` | Vitest |
| `npm run ci` | check + typecheck + tests |
| `npm run generate:icons` | Régénère le catalogue d’icônes Material Symbols |
