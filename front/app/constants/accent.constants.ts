import { APP_ROUTE } from './route.constants';

/**
 * Clés de dominance visuelle. Chaque clé a un bloc `[data-accent="…"]` dans `app.css`.
 * `neutral` = défaut (accueil, login, routes non mappées).
 */
export const APP_ACCENT = {
  neutral: 'neutral',
  accounts: 'accounts',
  work: 'work',
  categories: 'categories',
  settings: 'settings',
} as const;

export type AppAccent = (typeof APP_ACCENT)[keyof typeof APP_ACCENT];

export const DEFAULT_ACCENT: AppAccent = APP_ACCENT.neutral;

/**
 * Préfixe de route → accent. Le plus long préfixe gagne (sous-routes héritées).
 * Pour une nouvelle page colorée : ajouter la clé dans APP_ACCENT + le CSS + une entrée ici.
 */
export const ROUTE_ACCENT = [
  { prefix: APP_ROUTE.accounts, accent: APP_ACCENT.accounts },
  { prefix: APP_ROUTE.work, accent: APP_ACCENT.work },
  { prefix: APP_ROUTE.settings, accent: APP_ACCENT.settings },
  { prefix: APP_ROUTE.home, accent: APP_ACCENT.neutral },
  { prefix: APP_ROUTE.login, accent: APP_ACCENT.neutral },
] as const satisfies ReadonlyArray<{ prefix: string; accent: AppAccent }>;

export function resolveAccent(pathname: string): AppAccent {
  const path = pathname.replace(/\/+$/, '') || '/';

  let best: AppAccent = DEFAULT_ACCENT;
  let bestLength = -1;

  for (const { prefix, accent } of ROUTE_ACCENT) {
    const matches = prefix === '/' ? path === '/' : path === prefix || path.startsWith(`${prefix}/`);
    if (matches && prefix.length > bestLength) {
      best = accent;
      bestLength = prefix.length;
    }
  }

  return best;
}
