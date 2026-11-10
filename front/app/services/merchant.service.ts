import type { Merchant } from '@app-types';

import { ApiError, apiFetch, readJson } from './api-client';
import { invalidateMerchantImage } from './merchant-image-cache';

async function parseError(response: Response, fallback: string): Promise<never> {
  try {
    const payload = await readJson<{ message?: string }>(response);
    throw new ApiError(payload.message ?? fallback, response.status);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(fallback, response.status);
  }
}

export async function listMerchants(token: string): Promise<Merchant[]> {
  const response = await apiFetch('/api/merchants', { method: 'GET' }, token);
  if (!response.ok) {
    return parseError(response, 'Impossible de charger les enseignes.');
  }
  return readJson<Merchant[]>(response);
}

export async function createMerchant(
  token: string,
  body: { name: string; color: string; icon: string; position?: number; categoryIds?: string[] },
): Promise<Merchant> {
  const response = await apiFetch('/api/merchants', { method: 'POST', body: JSON.stringify(body) }, token);
  if (!response.ok) {
    return parseError(response, 'Création d’enseigne impossible.');
  }
  return readJson<Merchant>(response);
}

export async function updateMerchant(
  token: string,
  id: string,
  body: Partial<{ name: string; color: string; icon: string; position: number; categoryIds: string[] }>,
): Promise<Merchant> {
  const response = await apiFetch(`/api/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, token);
  if (!response.ok) {
    return parseError(response, 'Mise à jour d’enseigne impossible.');
  }
  const merchant = await readJson<Merchant>(response);
  // Passage en icône (ou remplacement) : l’ancienne image ne doit plus être servie.
  if (body.icon !== undefined) {
    invalidateMerchantImage(id);
  }
  return merchant;
}

export async function archiveMerchant(token: string, id: string): Promise<Merchant> {
  const response = await apiFetch(`/api/merchants/${id}`, { method: 'DELETE' }, token);
  if (!response.ok) {
    return parseError(response, 'Suppression d’enseigne impossible.');
  }
  invalidateMerchantImage(id);
  return readJson<Merchant>(response);
}

export async function uploadMerchantImage(token: string, id: string, file: File): Promise<Merchant> {
  const body = new FormData();
  body.append('file', file);
  const response = await apiFetch(`/api/merchants/${id}/image`, { method: 'POST', body }, token);
  if (!response.ok) {
    return parseError(response, 'Upload de l’image impossible.');
  }
  invalidateMerchantImage(id);
  return readJson<Merchant>(response);
}

export async function clearMerchantImage(token: string, id: string): Promise<Merchant> {
  const response = await apiFetch(`/api/merchants/${id}/image`, { method: 'DELETE' }, token);
  if (!response.ok) {
    return parseError(response, 'Suppression de l’image impossible.');
  }
  invalidateMerchantImage(id);
  return readJson<Merchant>(response);
}
