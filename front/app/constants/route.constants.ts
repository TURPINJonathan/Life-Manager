export const APP_ROUTE = {
  home: '/',
  login: '/login',
  accounts: '/comptes',
  accountLedger: '/comptes/:subAccountId',
  accountNew: '/comptes/nouveau',
  work: '/travail',
  workJob: '/travail/:jobId',
  workNew: '/travail/nouveau',
  settings: '/parametres',
  settingsSection: '/parametres/:section',
} as const;

export const APP_NAME = 'Life Manager';

/** Titre d’onglet : `Partie · … · Life Manager`. Sans partie → `Life Manager`. */
export function appTitle(...parts: Array<string | null | undefined>): string {
  const cleaned = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return cleaned.length > 0 ? `${cleaned.join(' · ')} · ${APP_NAME}` : APP_NAME;
}

export function accountLedgerPath(
  subAccountId: string,
  view?: 'operations' | 'budget',
  options?: { yearMonth?: string; lineId?: string },
): string {
  const base = `/comptes/${subAccountId}`;
  const params = new URLSearchParams();
  if (view === 'budget') params.set('vue', 'budget');
  if (options?.yearMonth) params.set('mois', options.yearMonth);
  if (options?.lineId) params.set('ligne', options.lineId);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function settingsPath(
  section: 'profil' | 'comptes' | 'travail' | 'categories' | 'enseignes' = 'profil',
): string {
  return `/parametres/${section}`;
}

export function workJobPath(
  jobId: string,
  tabOrOptions?:
    'pointeuse' | 'planning' | 'documents' | { tab?: 'pointeuse' | 'planning' | 'documents'; day?: string },
): string {
  const options = typeof tabOrOptions === 'string' || tabOrOptions === undefined ? { tab: tabOrOptions } : tabOrOptions;
  const params = new URLSearchParams();
  if (options.tab && options.tab !== 'pointeuse') {
    params.set('onglet', options.tab);
  }
  if (options.day) {
    params.set('jour', options.day);
  }
  const query = params.toString();
  return query ? `/travail/${jobId}?${query}` : `/travail/${jobId}`;
}

export function shiftYearMonth(yearMonth: string, delta: number): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function currentYearMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
