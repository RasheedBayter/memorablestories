import { readSettings, RUNNABLE_STAGES } from '@/server/settings';
import { isWired, STAGE_LABEL } from '@/server/data';
import { VOICE_CATALOG } from '@/server/script';
import { getSystemHealth } from '@/server/health';
import { PENDING_WIRING } from '@/lib/pipeline/handlers';
import { SettingsForm } from '@/components/settings-form';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Card, Chip, Label, Notice } from '@/components/ui';

/**
 * P11 · Ajustes y política de autopilot.
 *
 * La política vive en `.data/settings.json`, junto al backlog: el estado de este
 * sistema está en disco mientras el guion y el render corran en la máquina
 * local. Hasta que el operador guarda una vez, la interfaz rotula los valores
 * como "por defecto" en lugar de hacerlos pasar por decisión suya.
 */
export default async function SettingsPage() {
  const [settings, health] = await Promise.all([readSettings(), getSystemHealth()]);

  const stages = RUNNABLE_STAGES.map((s) => ({
    stage: s,
    label: STAGE_LABEL[s],
    mode: settings.autopilot.stages[s] ?? 'manual',
    wired: isWired(s),
    missing: PENDING_WIRING[s],
  }));

  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <div className="flex items-center gap-3">
        <h1 className="text-[17px] font-semibold text-ink">Ajustes</h1>
        <span className="font-mono text-[11px] text-ink-3">.data/settings.json</span>
        {settings.persisted ? (
          <Chip tone="done">guardado</Chip>
        ) : (
          <Chip tone="fixture">valores por defecto — aún sin guardar</Chip>
        )}
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </div>

      <div className="grid grid-cols-[1fr_372px] items-start gap-4">
        <SettingsForm settings={settings} stages={stages} voices={VOICE_CATALOG.map((v) => ({ ...v }))} />

        <aside className="flex flex-col gap-3.5">
          <Card className="flex flex-col gap-2 px-4 py-3.5">
            <Label>Credenciales detectadas</Label>
            <Row k="ElevenLabs" v={health.eleven.ok ? `${health.eleven.tier} · ok` : (health.eleven.error ?? 'sin dato')} />
            <Row k="Higgsfield" v={health.higgsfield.ok ? `ok · ${health.higgsfield.motions} presets` : (health.higgsfield.error ?? 'sin dato')} />
            <Row k="Anthropic" v={health.anthropicKey ? 'configurada' : 'ausente — el guion lo escribe Claude Code local'} />
            <Row k="YouTube OAuth" v={health.youtubeCredentials ? 'configurada' : 'ausente — publish corre en dryRun'} />
            <Row k="ELEVENLABS_VOICE_ID_EN" v={health.voiceEn ?? 'sin fijar'} />
            <Row k="ELEVENLABS_VOICE_ID_ES" v={health.voiceEs ?? 'sin fijar'} />
            <span className="text-[10.5px] leading-[1.5] text-ink-3">
              Las claves se leen de <span className="font-mono">.env.local</span> y nunca se muestran: solo si están o
              no, y qué contesta el proveedor.
            </span>
          </Card>

          <Notice tone="wait" title="Voces por defecto: 31/12/2026">
            Los IDs por defecto de ElevenLabs expiran ese día. Guardar una voz aquí la fija en{' '}
            <span className="font-mono">settings.json</span>, que es donde el manejador de{' '}
            <span className="font-mono">narrate</span> la buscará antes que en el entorno.
          </Notice>

          <Notice tone="muted" title="Cadencia máxima: tope duro de 2/día">
            El formulario no deja subir de ahí. Más de 5 vídeos diarios con plantilla fija es exactamente el patrón que
            la política de contenido inauténtico castiga, y en enero de 2026 costó 16 canales y 35 M de suscriptores.
          </Notice>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="flex-none text-[11.5px] text-ink-2">{k}</span>
      <span className="truncate text-right font-mono text-[10.5px] tnum text-ink">{v}</span>
    </div>
  );
}
