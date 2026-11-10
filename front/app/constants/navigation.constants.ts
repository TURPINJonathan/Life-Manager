import type { INavItem } from '@app-types';

import { APP_ROUTE } from './route.constants';

export const NAV_ITEMS = [
  { to: APP_ROUTE.home, label: 'Accueil', icon: 'dashboard' },
  { to: APP_ROUTE.accounts, label: 'Comptes', icon: 'account_balance_wallet' },
  { to: APP_ROUTE.work, label: 'Travail', icon: 'work' },
] as const satisfies readonly INavItem[];

export const MENU_ITEMS = [
  { to: APP_ROUTE.settings, label: 'Paramètres', icon: 'settings' },
] as const satisfies readonly INavItem[];
