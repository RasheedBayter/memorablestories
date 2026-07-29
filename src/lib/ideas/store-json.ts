import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IdeaStore, StoredIdea } from './pipeline';
import type { NarrativeTemplate } from './scoring';

/**
 * Persistencia en fichero JSON.
 *
 * Existe para que el motor de ideas funcione desde el primer día sin depender
 * de Supabase, R2 ni ninguna cuenta. Cuando la base de datos esté montada, se
 * sustituye por `PostgresIdeaStore` sin tocar `pipeline.ts`: esa es toda la
 * razón de que `IdeaStore` sea una interfaz.
 *
 * No es apto para producción: reescribe el fichero entero en cada guardado y no
 * tiene control de concurrencia.
 */
export class JsonIdeaStore implements IdeaStore {
  constructor(private readonly filePath: string = path.join(process.cwd(), '.data', 'ideas.json')) {}

  private async load(): Promise<StoredIdea[]> {
    try {
      return JSON.parse(await readFile(this.filePath, 'utf8')) as StoredIdea[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async listSeen(): Promise<Array<{ id: string; text: string }>> {
    // Todo lo visto, incluidas las descartadas: si solo se comparase contra lo
    // publicado, las ideas rechazadas reaparecerían cada noche y el backlog
    // nunca convergería.
    const all = await this.load();
    return all.map((i) => ({ id: i.id, text: `${i.title ?? ''} ${i.text}`.trim() }));
  }

  async recentTemplates(limit: number): Promise<NarrativeTemplate[]> {
    const all = await this.load();
    return all
      .filter((i) => i.status === 'produced' || i.status === 'approved')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((i) => i.template);
  }

  async save(ideas: StoredIdea[]): Promise<void> {
    const existing = await this.load();
    const byId = new Map(existing.map((i) => [i.id, i]));

    for (const idea of ideas) {
      // No pisar el estado si un humano ya decidió sobre esta idea.
      const prev = byId.get(idea.id);
      if (prev && prev.status !== 'pending') continue;
      byId.set(idea.id, idea);
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify([...byId.values()], null, 2), 'utf8');
  }

  async listBacklog(limit = 50): Promise<StoredIdea[]> {
    const all = await this.load();
    return all
      .filter((i) => !i.rejected && i.status === 'pending')
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
