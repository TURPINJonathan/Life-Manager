import { AUTH_STATUS, TOKEN_STORAGE_KEY } from '@constants';
import { ApiError, clearMerchantImageCache, fetchMe, loginRequest } from '@services';
import type { AuthStatus, AuthUser } from '@app-types';
import { create } from 'zustand';

type AuthState = {
  status: AuthStatus;
  user: AuthUser | null;
  token: string | null;
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

let bootstrapPromise: Promise<void> | null = null;

function readStoredToken(): string | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  const fromLocal = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (fromLocal) {
    return fromLocal;
  }

  // Migration one-shot depuis l’ancien stockage session.
  if (typeof sessionStorage !== 'undefined') {
    const legacy = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (legacy) {
      localStorage.setItem(TOKEN_STORAGE_KEY, legacy);
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      return legacy;
    }
  }

  return null;
}

function writeStoredToken(token: string | null): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
    return;
  }

  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export const useAuthStore = create<AuthState>((set) => ({
  status: AUTH_STATUS.pending,
  user: null,
  token: null,
  error: null,
  bootstrap: () => {
    bootstrapPromise ??= (async () => {
      const token = readStoredToken();
      if (!token) {
        set({ status: AUTH_STATUS.unauthenticated, user: null, token: null, error: null });
        return;
      }

      set({ status: AUTH_STATUS.pending, token, error: null });
      try {
        const user = await fetchMe(token);
        set({ status: AUTH_STATUS.authenticated, user, token, error: null });
      } catch (error) {
        writeStoredToken(null);
        const message = error instanceof ApiError ? error.message : 'Session indisponible.';
        const status =
          error instanceof ApiError && error.status === 401 ? AUTH_STATUS.unauthenticated : AUTH_STATUS.error;
        set({ status, user: null, token: null, error: status === AUTH_STATUS.error ? message : null });
      }
    })();

    return bootstrapPromise;
  },
  login: async (email, password) => {
    set({ status: AUTH_STATUS.pending, error: null });
    try {
      const token = await loginRequest(email, password);
      const user = await fetchMe(token);
      writeStoredToken(token);
      bootstrapPromise = Promise.resolve();
      set({ status: AUTH_STATUS.authenticated, user, token, error: null });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Connexion impossible.';
      set({ status: AUTH_STATUS.unauthenticated, user: null, token: null, error: message });
      throw error;
    }
  },
  logout: () => {
    writeStoredToken(null);
    bootstrapPromise = Promise.resolve();
    clearMerchantImageCache();
    set({ status: AUTH_STATUS.unauthenticated, user: null, token: null, error: null });
  },
}));
