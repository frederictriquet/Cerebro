import type { CerebroDatabase } from './db.ts';
// projectId null : opération lancée hors projet (council depuis l’accueil ou Slack).
export interface OperationResult {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  kind: 'push' | 'commit' | 'command' | 'epic' | 'council';
  ok: boolean;
  summary: string;
  startedAt: number;
  finishedAt: number;
  seenAt: number | null;
  notifiedAt: number | null;
}
export class OperationResults {
  private db: CerebroDatabase;
  private timers = new Map<string, NodeJS.Timeout>();
  private sending = new Set<string>();
  private failures = new Map<string, number>();
  private closed = false;
  delay: () => number = () => 30_000;
  // Attentes successives après un envoi en erreur ; au-delà, seul un redémarrage relance l’envoi.
  retryDelays: number[] = [30_000, 120_000, 600_000];
  wanted: (result: OperationResult) => boolean = () => false;
  // true uniquement après un envoi effectif ; false laisse le résultat en attente.
  send: (result: OperationResult) => Promise<boolean> = async () => false;
  onError: (cause: unknown) => void = () => {};
  constructor(db: CerebroDatabase) {
    this.db = db;
  }
  // Requêtes ciblées : la table grossit à chaque fin d’opération et ne doit jamais être parsée en entier.
  get(id: string): OperationResult | null {
    const row = this.db.connection.prepare('SELECT data FROM operation_results WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  list(projectId?: string): OperationResult[] {
    return (
      this.db.connection
        .prepare(
          projectId
            ? 'SELECT data FROM operation_results WHERE project_id=? ORDER BY rowid DESC'
            : 'SELECT data FROM operation_results ORDER BY rowid DESC',
        )
        .all(...(projectId ? [projectId] : [])) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  // Résultats terminés depuis since, plus récents d’abord.
  since(since: number): OperationResult[] {
    return (
      this.db.connection
        .prepare('SELECT data FROM operation_results WHERE finished_at>=? ORDER BY rowid DESC')
        .all(since) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  // Supprime les résultats terminés avant before ; leur notification n’est plus planifiable.
  purge(before: number): number {
    return Number(this.db.connection.prepare('DELETE FROM operation_results WHERE finished_at<?').run(before).changes);
  }
  private save(r: OperationResult): void {
    this.db.connection
      .prepare('INSERT INTO operation_results VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(r.id, JSON.stringify(r));
  }
  record(raw: Omit<OperationResult, 'seenAt' | 'notifiedAt'>): void {
    raw = { ...raw, summary: raw.summary.slice(0, 3000) };
    const old = this.get(raw.id);
    if (old && old.ok === raw.ok && old.summary === raw.summary && old.finishedAt === raw.finishedAt) return;
    const result = { ...raw, seenAt: null, notifiedAt: null };
    this.save(result);
    this.failures.delete(result.id);
    this.schedule(result);
  }
  restore(): void {
    for (const result of this.since(Date.now() - FRESH_MS)) this.schedule(result);
  }
  seen(id: string): void {
    const result = this.get(id);
    if (!result) return;
    result.seenAt = Date.now();
    this.save(result);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.failures.delete(id);
  }
  private schedule(result: OperationResult, wait = this.delay()): void {
    if (this.closed || result.seenAt || result.notifiedAt || !this.wanted(result)) return;
    const previous = this.timers.get(result.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(result.id);
      void this.deliver(result.id).catch(this.onError);
    }, wait);
    timer.unref();
    this.timers.set(result.id, timer);
  }
  async deliver(id: string): Promise<void> {
    const result = this.get(id);
    if (this.closed || !result || result.seenAt || result.notifiedAt || !this.wanted(result) || this.sending.has(id))
      return;
    this.sending.add(id);
    try {
      const sent = await this.send(result);
      if (!sent || this.closed) return;
      this.failures.delete(id);
      const latest = this.get(id);
      if (latest && latest.finishedAt === result.finishedAt) {
        latest.notifiedAt = Date.now();
        this.save(latest);
      }
    } catch (cause) {
      this.retry(result);
      throw cause;
    } finally {
      this.sending.delete(id);
    }
  }
  // Erreur d’envoi (429, réseau, délai) : nouvel essai tant que le résultat reste frais et non notifié.
  private retry(result: OperationResult): void {
    const attempt = this.failures.get(result.id) ?? 0;
    const wait = this.retryDelays[attempt];
    const latest = this.get(result.id);
    if (wait === undefined || !latest || latest.finishedAt !== result.finishedAt || !fresh(latest)) {
      this.failures.delete(result.id);
      return;
    }
    this.failures.set(result.id, attempt + 1);
    this.schedule(latest, wait);
  }
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.failures.clear();
  }
}
const FRESH_MS = 86_400_000;
function fresh(result: OperationResult): boolean {
  return Date.now() - result.finishedAt < FRESH_MS;
}
