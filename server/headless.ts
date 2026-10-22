import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from './db.ts';

/** `none`: no tool at all. `read-only`: the agent may read files below `cwd`, never write nor run anything that mutates. */
export type HeadlessAccess = 'none' | 'read-only';
export interface HeadlessMessages { timeout: string; aborted: string; failed: string }
export interface HeadlessOptions {
  agent: Agent; model: string | null; effort: string | null; prompt: string; schema: object;
  /** Working directory of the agent. Defaults to an empty private directory, removed afterwards. */
  cwd?: string; access: HeadlessAccess; timeoutMs: number; signal: AbortSignal;
  messages?: Partial<HeadlessMessages>;
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'];

function decode(text: string): unknown {
  const parsed=JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1'));
  if(parsed?.is_error||parsed?.type==='result'&&parsed.subtype&&parsed.subtype!=='success')throw new Error('L’agent n’a pas produit de proposition utilisable.');
  if(parsed?.stopReason&&parsed.stopReason!=='end_turn')throw new Error(`L’agent n’a pas terminé sa proposition (${parsed.stopReason}).`);
  if(parsed?.structured_output)return parsed.structured_output;
  if(parsed?.structuredOutput)return parsed.structuredOutput;
  if(typeof parsed?.result==='string')return decode(parsed.result);
  if(parsed?.result&&typeof parsed.result==='object')return parsed.result;
  if(typeof parsed?.text==='string')return decode(parsed.text);
  return parsed;
}

/** Subset of JSON Schema used by Cerebro's own schemas: type, enum, properties, required, additionalProperties:false, items, min/max. */
export function validateSchema(value: unknown, schema: any, path = '$'): void {
  const fail=(reason:string):never=>{throw new Error(`Réponse de l’agent non conforme au schéma (${path} : ${reason}).`);};
  if(!schema||typeof schema!=='object')return;
  if(Array.isArray(schema.enum)&&!schema.enum.some((option:unknown)=>option===value))fail('valeur inattendue');
  const types:string[]=schema.type===undefined?[]:[schema.type].flat();
  const kind=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
  if(types.length&&!types.some(type=>type===kind||type==='number'&&kind==='integer'))fail(`${types.join('|')} attendu`);
  if(typeof value==='string'){
    if(typeof schema.minLength==='number'&&value.length<schema.minLength)fail('texte trop court');
    if(typeof schema.maxLength==='number'&&value.length>schema.maxLength)fail('texte trop long');
  } else if(typeof value==='number'){
    if(typeof schema.minimum==='number'&&value<schema.minimum)fail('valeur trop petite');
    if(typeof schema.maximum==='number'&&value>schema.maximum)fail('valeur trop grande');
  } else if(Array.isArray(value)){
    if(typeof schema.minItems==='number'&&value.length<schema.minItems)fail('trop peu d’éléments');
    if(typeof schema.maxItems==='number'&&value.length>schema.maxItems)fail('trop d’éléments');
    value.forEach((item,index)=>validateSchema(item,schema.items,`${path}[${index}]`));
  } else if(value&&typeof value==='object'){
    const record=value as Record<string,unknown>;const properties=schema.properties??{};
    for(const key of schema.required??[])if(!(key in record))fail(`champ « ${key} » manquant`);
    for(const [key,item] of Object.entries(record)){
      if(key in properties)validateSchema(item,properties[key],`${path}.${key}`);
      else if(schema.additionalProperties===false)fail(`champ « ${key} » inattendu`);
    }
  }
}

// Top-level user settings forwarded to Codex: default model and how to authenticate, never tools nor MCP.
const CODEX_USER_SETTINGS=['model','model_reasoning_effort','openai_base_url','cli_auth_credentials_store','forced_login_method','forced_chatgpt_workspace_id'];

async function codexArgs(access: HeadlessAccess, schema: string, output: string, model: string | null, effort: string | null): Promise<string[]> {
  // In read-only mode the shell stays available for `cat`/`rg`, the read-only sandbox forbids any write.
  // `--ignore-user-config` drops the user's MCP servers, plugins and project trust: an approved project's
  // `.codex/config.toml` (MCP servers, hooks) is then never loaded; `--ignore-rules` drops execpolicy rules.
  const args=['exec','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--sandbox','read-only',...access==='none'?['--disable','shell_tool']:[],'--disable','unified_exec','--disable','multi_agent',
    '-c','approval_policy="never"','-c','web_search="disabled"','--output-schema',schema,'--output-last-message',output,'--json'];
  const config=await readFile(join(process.env.CODEX_HOME??join(homedir(),'.codex'),'config.toml'),'utf8').catch(()=> '');
  const explicit=new Set([model===null?'':'model',effort===null?'':'model_reasoning_effort']);
  for(const line of config.split('\n')){
    if(/^\s*\[/.test(line))break;
    const match=/^\s*([\w-]+)\s*=\s*("(?:[^"\\\n]|\\.)*"|'[^'\n]*')\s*(?:#.*)?$/.exec(line);
    if(match&&CODEX_USER_SETTINGS.includes(match[1])&&!explicit.has(match[1]))args.push('-c',`${match[1]}=${match[2]}`);
  }
  if(model!==null)args.push('-m',model);
  if(effort!==null)args.push('-c',`model_reasoning_effort=${JSON.stringify(effort)}`);
  return args;
}

function claudeArgs(access: HeadlessAccess, schema: string): string[] {
  // Tool permissions do not constrain hooks or commands from project/local settings.
  // Keep user settings for authentication, and explicitly disable customization hooks.
  return ['--print','--output-format','json','--json-schema',schema,'--tools',access==='none'?'':READ_TOOLS.join(','),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources','user','--settings','{"disableAllHooks":true}',
    '--permission-mode','dontAsk','--no-session-persistence','--disable-slash-commands',...access==='none'?[]:['--max-turns','30']];
}

function grokArgs(access: HeadlessAccess, schema: string, input: string): string[] {
  // Grok 1.0.67 accepts Claude's tool names: `--tools Read,Glob,Grep` (an unknown name only warns and leaves every tool on).
  // Plan mode is not used: it targets an interactive plan approval, while the tool allow-list plus `dontAsk`
  // already leaves no write or shell tool, and the explicit `--allow` rules keep reads from being refused.
  const tools=access==='none'?['--tools','','--deny','*']:['--tools',READ_TOOLS.join(','),...READ_TOOLS.flatMap(tool=>['--allow',tool])];
  return ['--prompt-file',input,'--output-format','json','--json-schema',schema,...tools,'--no-subagents','--disable-web-search','--max-turns',access==='none'?'2':'30','--permission-mode','dontAsk'];
}

/** Runs one non-interactive claude/codex/grok inference and returns its structured output, validated against `schema`. */
export async function runHeadless(options: HeadlessOptions): Promise<unknown> {
  const {agent,model,effort,prompt,access,timeoutMs,signal}=options;
  const messages:HeadlessMessages={timeout:`L’agent a dépassé le délai de ${Math.round(timeoutMs/1000)} s.`,aborted:'Exécution annulée.',failed:'n’a pas répondu',...options.messages};
  signal.throwIfAborted();
  const directory=await mkdtemp(join(tmpdir(),'cerebro-headless-'));
  try {
    const schema=join(directory,'schema.json');const output=join(directory,'result.json');const input=join(directory,'prompt.txt');
    const schemaText=JSON.stringify(options.schema);
    await writeFile(schema,schemaText);await writeFile(input,prompt,{mode:0o600});
    let args:string[];
    if(agent==='codex') {
      args=[...await codexArgs(access,schema,output,model,effort),'-'];
    } else {
      args=agent==='claude'?claudeArgs(access,schemaText):grokArgs(access,schemaText,input);
      if(model!==null)args.push('--model',model);
      if(effort!==null)args.push(agent==='claude'?'--effort':'--reasoning-effort',effort);
    }
    const env={...process.env};
    // Headless agents need CLI authentication, never Cerebro's server secrets or session helpers.
    for(const key of Object.keys(env))if(key.startsWith('CEREBRO_')||key==='CLAUDECODE')delete env[key];
    const text=await new Promise<string>((accept,reject)=>{
      signal.throwIfAborted();
      const child=spawn(agent,args,{cwd:options.cwd??directory,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      let stdout='';let stderr='';let failure:Error|null=null;let killTimer:NodeJS.Timeout|undefined;
      const kill=(force=false):void=>{try{if(process.platform==='win32')child.kill(force?'SIGKILL':'SIGTERM');else if(child.pid)process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch{}};
      const stop=(reason:Error):void=>{failure=reason;kill();killTimer??=setTimeout(()=>kill(true),2000);killTimer.unref();};
      const abort=():void=>stop(new Error(messages.aborted));
      signal.addEventListener('abort',abort,{once:true});
      const timeout=setTimeout(()=>stop(new Error(messages.timeout)),timeoutMs);timeout.unref();
      child.stdout.on('data',(data:Buffer)=>{stdout+=data.toString();if(Buffer.byteLength(stdout)>4*1024*1024)stop(new Error('Réponse de l’agent trop volumineuse.'));});
      child.stderr.on('data',(data:Buffer)=>{stderr=(stderr+data.toString()).slice(-8000);});
      const cleanup=():void=>{clearTimeout(timeout);clearTimeout(killTimer);signal.removeEventListener('abort',abort);};
      child.on('error',cause=>{cleanup();reject(cause);});
      child.on('close',code=>{cleanup();if(failure)reject(failure);else if(code!==0)reject(new Error(`${agent} ${messages.failed} : ${stderr||`code ${code}`}`));else accept(stdout);});
      child.stdin.on('error',()=>{});child.stdin.end(agent==='grok'?undefined:prompt);
    });
    signal.throwIfAborted();
    const result=decode(agent==='codex'?await readFile(output,'utf8'):text);
    validateSchema(result,options.schema);
    return result;
  } finally {await rm(directory,{recursive:true,force:true});}
}
