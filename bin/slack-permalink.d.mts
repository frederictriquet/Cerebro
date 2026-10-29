/** Canal et fil d'un lien Slack (threadTs null pour le canal seul), ou null si ce n'est pas un lien Slack. */
export function parseSlackPermalink(value: string): { channel: string; threadTs: string | null } | null;
