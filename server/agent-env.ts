// Agents run with the user's environment minus every Cerebro server variable (bind token, Slack
// credentials, data directory...): whatever a session needs is added back explicitly by its caller.
export function withoutCerebroVariables(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith('CEREBRO_')) delete env[key];
  return env;
}
