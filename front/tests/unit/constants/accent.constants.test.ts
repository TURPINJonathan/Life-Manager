import { describe, expect, it } from 'vitest';

import { APP_ACCENT, resolveAccent } from '../../../app/constants/accent.constants';

describe('resolveAccent', () => {
  it('returns neutral for home and login', () => {
    expect(resolveAccent('/')).toBe(APP_ACCENT.neutral);
    expect(resolveAccent('/login')).toBe(APP_ACCENT.neutral);
  });

  it('maps section routes and inherits nested paths', () => {
    expect(resolveAccent('/comptes')).toBe(APP_ACCENT.accounts);
    expect(resolveAccent('/comptes/nouveau')).toBe(APP_ACCENT.accounts);
    expect(resolveAccent('/travail')).toBe(APP_ACCENT.work);
    expect(resolveAccent('/parametres')).toBe(APP_ACCENT.settings);
  });

  it('does not treat every path as home', () => {
    expect(resolveAccent('/inconnu')).toBe(APP_ACCENT.neutral);
  });
});
