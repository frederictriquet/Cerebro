// Lien Slack « Copier le lien » → canal et fil : https://<espace>.slack.com/archives/<canal>/p<ts sans point>, avec
// `?thread_ts=…` pour une réponse dans un fil. Le lien d'un message hors fil désigne le fil qu'il ouvre ; celui
// d'un canal seul (sans /p…), le niveau principal du canal.

// Rend { channel, threadTs } (threadTs null pour le canal seul), ou null si ce n'est pas un lien Slack.
export function parseSlackPermalink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)slack\.com$/.test(url.hostname)) return null;
  const match = /^\/archives\/([A-Z0-9]+)(?:\/p(\d{7,}))?\/?$/.exec(url.pathname);
  if (match === null) return null;
  const [, channel, packed] = match;
  if (packed === undefined) return { channel, threadTs: null };
  const thread = url.searchParams.get('thread_ts');
  return {
    channel,
    threadTs: thread !== null && /^\d+\.\d+$/.test(thread) ? thread : `${packed.slice(0, -6)}.${packed.slice(-6)}`,
  };
}
