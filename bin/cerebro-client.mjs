// Client HTTP commun des commandes cerebro-* (JS pur, sans dépendance) : elles appellent l'API du
// serveur avec le jeton de la session qui les a lancées.

const { CEREBRO_SESSION_ID, CEREBRO_TOKEN, CEREBRO_URL } = process.env;

export function inSession() {
  return Boolean(CEREBRO_SESSION_ID && CEREBRO_TOKEN && CEREBRO_URL);
}

export function requireSession() {
  if (!inSession()) throw new Error('uniquement dans une session Cerebro');
}

// Préfixe d'API propre à la session courante, par exemple sessionPath('backlog') → /api/backlog/<id>.
export function sessionPath(resource) {
  requireSession();
  return `/api/${resource}/${encodeURIComponent(CEREBRO_SESSION_ID)}`;
}

// `init.body` est encodé en JSON. Une réponse en erreur lève une Error portant le message `error` du
// serveur (sinon le statut HTTP, ou `tooLarge` pour un 413) ; une réponse 204 renvoie null. Un proxy
// peut répondre en HTML : une réponse illisible lève une erreur qui garde le statut HTTP.
export async function request(path, { method = 'GET', body, tooLarge } = {}) {
  requireSession();
  const response = await fetch(`${CEREBRO_URL.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'x-cerebro-token': CEREBRO_TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // Keep the HTTP status when the server did not return JSON.
  }
  if (!response.ok) {
    if (response.status === 413 && tooLarge !== undefined) throw new Error(tooLarge);
    throw new Error(typeof payload?.error === 'string' ? payload.error : `Erreur HTTP ${response.status}`);
  }
  if (payload === undefined) throw new Error(`Réponse illisible du serveur (HTTP ${response.status}).`);
  return payload;
}

// Exécute la commande et rapporte toute erreur sur stderr, préfixée du nom de la commande sauf `prefix: false`.
export async function run(command, main, { prefix = true } = {}) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${prefix ? `${command} : ` : ''}${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
