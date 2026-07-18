import { CONFIG } from './config.js';

let client = null;

export function isBackendConfigured() {
  return /^https:\/\/.+\.supabase\.co\/?$/i.test(String(CONFIG.supabaseUrl || '').trim())
    && String(CONFIG.supabaseAnonKey || '').trim().length > 40
    && !String(CONFIG.supabaseAnonKey).includes('PASTE_');
}

export function getClient() {
  if (!isBackendConfigured()) return null;
  if (client) return client;
  if (!window.supabase?.createClient) throw new Error('Бібліотека Supabase не завантажилася.');

  client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}

function throwOnError(result) {
  if (result?.error) throw result.error;
  return result?.data;
}

export async function listSupportPoints() {
  return throwOnError(await getClient().rpc('list_support_points')) || [];
}

export async function listHelpNeeds() {
  return throwOnError(await getClient().rpc('list_help_needs')) || [];
}

export async function createSupportPoint(payload, secret, photoPath) {
  return throwOnError(await getClient().rpc('create_support_point', {
    p_payload: payload,
    p_secret: secret,
    p_photo_path: photoPath,
  }));
}

export async function updateSupportPoint(pointId, secret, payload, photoPath = null) {
  return throwOnError(await getClient().rpc('update_support_point', {
    p_point_id: pointId,
    p_secret: secret,
    p_payload: payload,
    p_photo_path: photoPath,
  }));
}

export async function getOwnedSupportPoint(pointId, secret) {
  return throwOnError(await getClient().rpc('get_owned_support_point', {
    p_point_id: pointId,
    p_secret: secret,
  }));
}

export async function closeSupportPoint(pointId, secret) {
  return throwOnError(await getClient().rpc('close_support_point', {
    p_point_id: pointId,
    p_secret: secret,
  }));
}

export async function reportPointAbsent(pointId, reporterKey) {
  return throwOnError(await getClient().rpc('report_point_absent', {
    p_point_id: pointId,
    p_reporter_key: reporterKey,
  }));
}

export async function confirmPointPresent(pointId, reporterKey) {
  return throwOnError(await getClient().rpc('confirm_point_present', {
    p_point_id: pointId,
    p_reporter_key: reporterKey,
  }));
}

export async function createHelpNeed(payload, secret) {
  return throwOnError(await getClient().rpc('create_help_need', {
    p_payload: payload,
    p_secret: secret,
  }));
}

export async function updateHelpNeed(needId, secret, payload) {
  return throwOnError(await getClient().rpc('update_help_need', {
    p_need_id: needId,
    p_secret: secret,
    p_payload: payload,
  }));
}

export async function getOwnedHelpNeed(needId, secret) {
  return throwOnError(await getClient().rpc('get_owned_help_need', {
    p_need_id: needId,
    p_secret: secret,
  }));
}

export async function closeHelpNeed(needId, secret) {
  return throwOnError(await getClient().rpc('close_help_need', {
    p_need_id: needId,
    p_secret: secret,
  }));
}

export async function claimHelpNeed(needId, claimantKey) {
  return throwOnError(await getClient().rpc('claim_help_need', {
    p_need_id: needId,
    p_claimant_key: claimantKey,
  }));
}

export async function uploadPointPhoto(blob) {
  const extension = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  const path = `points/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${extension}`;
  const result = await getClient().storage.from(CONFIG.photoBucket).upload(path, blob, {
    cacheControl: '3600',
    contentType: blob.type || 'image/jpeg',
    upsert: false,
  });
  throwOnError(result);
  return path;
}

export function getPointPhotoUrl(path) {
  if (!path || !isBackendConfigured()) return '';
  return getClient().storage.from(CONFIG.photoBucket).getPublicUrl(path).data.publicUrl;
}
