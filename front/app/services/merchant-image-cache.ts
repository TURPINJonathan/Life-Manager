import { apiFetch } from './api-client';

type CacheEntry = {
  blobUrl: string;
  /** Fetch en cours (déduplique les mounts simultanés). */
  inflight: Promise<string | null> | null;
};

const cache = new Map<string, CacheEntry>();

export function merchantImagePath(merchantId: string): string {
  return `/api/merchants/${merchantId}/image`;
}

/** Lecture synchrone — évite le flash icône si déjà en cache. */
export function peekMerchantImageSrc(imageUrl: string): string | null {
  const url = cache.get(imageUrl)?.blobUrl;
  return url ? url : null;
}

/**
 * Retourne une blob URL stable pour l’image auth.
 * Cache mémoire partagé : un seul fetch par enseigne, réutilisé au remontage
 * jusqu’à invalidation (upload / suppression / logout).
 */
export async function resolveMerchantImageSrc(imageUrl: string, token: string): Promise<string | null> {
  const existing = cache.get(imageUrl);
  if (existing?.blobUrl) return existing.blobUrl;
  if (existing?.inflight) return existing.inflight;
  return fetchAndStore(imageUrl, token);
}

async function fetchAndStore(imageUrl: string, token: string): Promise<string | null> {
  const pending = cache.get(imageUrl);
  if (pending?.inflight) return pending.inflight;
  if (pending?.blobUrl) return pending.blobUrl;

  const inflight = (async (): Promise<string | null> => {
    try {
      const response = await apiFetch(imageUrl, { method: 'GET' }, token);
      if (!response.ok) return null;
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      cache.set(imageUrl, { blobUrl, inflight: null });
      return blobUrl;
    } catch {
      return null;
    }
  })();

  cache.set(imageUrl, { blobUrl: '', inflight });

  const result = await inflight;
  const entry = cache.get(imageUrl);
  if (entry) entry.inflight = null;
  if (!result) {
    cache.delete(imageUrl);
  }
  return result;
}

export function invalidateMerchantImage(merchantIdOrUrl: string): void {
  const key = merchantIdOrUrl.startsWith('/') ? merchantIdOrUrl : merchantImagePath(merchantIdOrUrl);
  const entry = cache.get(key);
  if (!entry) return;
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  cache.delete(key);
}

export function clearMerchantImageCache(): void {
  for (const entry of cache.values()) {
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  }
  cache.clear();
}
