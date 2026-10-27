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
// serveur (sinon le statut HTTP) ; une réponse 204 renvoie null.
export async function request(path, { method = 'GET', body } = {}) {
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
  if (!response.ok) {
    let message = `Erreur HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (typeof payload === 'object' && payload !== null && typeof payload.error === 'string') message = payload.error;
    } catch {
      // Keep the HTTP status when the server did not return JSON.
    }
    if (response.status === 413) message = 'envoi trop volumineux : découpez-le en plusieurs appels';
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

// Exécute la commande et rapporte toute erreur sur stderr, préfixée du nom de la commande.
export async function run(command, main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${command} : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
