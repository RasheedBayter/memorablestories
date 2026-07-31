import 'server-only';
import { JsonQuotaStore, QuotaLedger, DAILY_UNIT_LIMIT, DAILY_UPLOAD_LIMIT, estimateVideoBudget } from '@/lib/publish/quota';
import { QUOTA_FILE } from './paths';

/**
 * Salud del sistema, medida contra los proveedores reales.
 *
 * Cada comprobación devuelve `unknown` cuando no se pudo medir. La sala de
 * control muestra "sin dato" en ese caso — nunca un cero ni un valor plausible.
 * Un panel de salud que miente es peor que no tenerlo.
 */

export type ProbeState = 'ok' | 'warn' | 'blocked' | 'unknown';

export interface Probe {
  key: string;
  label: string;
  state: ProbeState;
  value: string;
  detail?: string;
  /** Bloquea la publicación. Solo el audit de YouTube lo está hoy. */
  blocking?: boolean;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ElevenHealth {
  ok: boolean;
  tier?: string;
  used?: number;
  limit?: number;
  resetAt?: string;
  error?: string;
}

export async function checkElevenLabs(): Promise<ElevenHealth> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return { ok: false, error: 'Falta ELEVENLABS_API_KEY' };
  const res = await withTimeout(
    fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': key },
      cache: 'no-store',
    }),
    6000,
  );
  if (!res) return { ok: false, error: 'sin respuesta en 6 s' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const body = (await res.json()) as {
    tier?: string;
    character_count?: number;
    character_limit?: number;
    next_character_count_reset_unix?: number;
  };
  return {
    ok: true,
    tier: body.tier,
    used: body.character_count,
    limit: body.character_limit,
    resetAt: body.next_character_count_reset_unix
      ? new Date(body.next_character_count_reset_unix * 1000).toISOString()
      : undefined,
  };
}

export interface HiggsfieldHealth {
  ok: boolean;
  motions?: number;
  creditUsd?: number;
  error?: string;
}

export async function checkHiggsfield(): Promise<HiggsfieldHealth> {
  const key = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_API_SECRET;
  if (!key || !secret) return { ok: false, error: 'Faltan HIGGSFIELD_API_KEY / HIGGSFIELD_API_SECRET' };
  const res = await withTimeout(
    fetch('https://platform.higgsfield.ai/v1/motions', {
      headers: { Authorization: `Key ${key}:${secret}`, Accept: 'application/json' },
      cache: 'no-store',
    }),
    8000,
  );
  if (!res) return { ok: false, error: 'sin respuesta en 8 s' };
  if (res.status === 402) return { ok: false, error: 'sin créditos (402)' };
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const motions = (await res.json()) as unknown[];
  return {
    ok: true,
    motions: Array.isArray(motions) ? motions.length : undefined,
    creditUsd: process.env.HIGGSFIELD_CREDIT_USD ? Number(process.env.HIGGSFIELD_CREDIT_USD) : undefined,
  };
}

export interface QuotaHealth {
  units: number;
  unitLimit: number;
  uploads: number;
  uploadLimit: number;
  perVideoUnits: number;
}

export async function checkQuota(): Promise<QuotaHealth> {
  const ledger = new QuotaLedger(new JsonQuotaStore(QUOTA_FILE));
  const snap = await ledger.snapshot();
  return {
    units: snap.units,
    unitLimit: DAILY_UNIT_LIMIT,
    uploads: snap.uploads,
    uploadLimit: DAILY_UPLOAD_LIMIT,
    perVideoUnits: estimateVideoBudget().units,
  };
}

export interface SystemHealth {
  eleven: ElevenHealth;
  higgsfield: HiggsfieldHealth;
  quota: QuotaHealth;
  /** El audit de YouTube es el camino crítico: sin él todo sube `private`. */
  youtubeAudit: 'pending' | 'approved';
  youtubeCredentials: boolean;
  anthropicKey: boolean;
  voiceEn?: string;
  voiceEs?: string;
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [eleven, higgsfield, quota] = await Promise.all([
    checkElevenLabs(),
    checkHiggsfield(),
    checkQuota(),
  ]);
  return {
    eleven,
    higgsfield,
    quota,
    // No hay forma de consultarlo por API: el audit se pide por formulario y se
    // responde por correo. Mientras no se marque a mano, se asume pendiente —
    // que es el supuesto seguro, porque el error es irreversible.
    youtubeAudit: process.env.YOUTUBE_AUDIT_APPROVED === 'true' ? 'approved' : 'pending',
    youtubeCredentials: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET),
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    voiceEn: process.env.ELEVENLABS_VOICE_ID_EN,
    voiceEs: process.env.ELEVENLABS_VOICE_ID_ES,
  };
}
