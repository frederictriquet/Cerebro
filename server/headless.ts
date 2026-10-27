import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Agent, Effort } from '../shared/types.ts';
import { tuningArgs } from './agent-args.ts';
import { readCodexConfig } from './codex-config.ts';
import { jsonlFromEnd } from './jsonl.ts';
import { killWithEscalation } from './proc.ts';

/** `none`: no tool at all. `read-only`: the agent may read files below `cwd`, never write nor run anything that mutates. */
export type HeadlessAccess = 'none' | 'read-only';
export interface HeadlessMessages { timeout: string; aborted: string; failed: string }
export interface HeadlessOptions {
  agent: Agent; model: string | null; effort: Effort | null; prompt: string; schema: object;
  /** Working directory of the agent. Defaults to an empty private directory, removed afterwards. */
  cwd?: string; access: HeadlessAccess; timeoutMs: number; signal: AbortSignal;
  /** Absolute paths of images attached to the prompt itself, so the agent sees them without any tool. */
  images?: readonly string[];
  messages?: Partial<HeadlessMessages>;
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'];

/** Image formats accepted as attachments, by file extension (lower case, without the dot). */
export const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function imageMediaType(path: string): string | null {
  return IMAGE_MEDIA_TYPES[extname(path).slice(1).toLowerCase()] ?? null;
}

/** Agents able to receive images attached to a headless prompt: Claude (stream-json input) and Codex (`--image`). */
export function supportsImages(agent: Agent): boolean {
  return agent === 'claude' || agent === 'codex';
}

// Claude's stream-json output: one JSON object per line, the final `result` line carries the structured output.
function resultRecord(text: string): unknown {
  for(const record of jsonlFromEnd(text))if((record as any)?.type==='result')return record;
  throw new Error('L’agent n’a pas produit de résultat final.');
}

function decode(text: string): unknown {
  return interpret(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1')));
}

function interpret(parsed: any): unknown {
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

function codexArgs(access: HeadlessAccess, schema: string, output: string, model: string | null, effort: Effort | null, images: readonly string[]): string[] {
  // In read-only mode the shell stays available for `cat`/`rg`, the read-only sandbox forbids any write.
  // `--ignore-user-config` drops the user's MCP servers, plugins and project trust: an approved project's
  // `.codex/config.toml` (MCP servers, hooks) is then never loaded; `--ignore-rules` drops execpolicy rules.
  // Each image gets its own `--image` so the variadic flag never swallows the `-` prompt argument.
  const args=['exec','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','--sandbox','read-only',...access==='none'?['--disable','shell_tool']:[],'--disable','unified_exec','--disable','multi_agent',
    '-c','approval_policy="never"','-c','web_search="disabled"',...images.flatMap(image=>['--image',image]),'--output-schema',schema,'--output-last-message',output,'--json'];
  const config=readCodexConfig();
  const explicit=new Set([model===null?'':'model',effort===null?'':'model_reasoning_effort']);
  for(const name of CODEX_USER_SETTINGS){
    const value=config.get(name);
    if(typeof value==='string'&&!explicit.has(name))args.push('-c',`${name}=${JSON.stringify(value)}`);
  }
  return [...args,...tuningArgs('codex',{model,effort})];
}

function claudeArgs(access: HeadlessAccess, schema: string, withImages: boolean): string[] {
  // Tool permissions do not constrain hooks or commands from project/local settings.
  // Keep user settings for authentication, and explicitly disable customization hooks.
  // Images can only travel inside a stream-json user message, which requires stream-json output (and `--verbose`).
  const format=withImages?['--verbose','--input-format','stream-json','--output-format','stream-json']:['--output-format','json'];
  return ['--print',...format,'--json-schema',schema,'--tools',access==='none'?'':READ_TOOLS.join(','),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
    '--setting-sources','user','--settings','{"disableAllHooks":true}',
    '--permission-mode','dontAsk','--no-session-persistence','--disable-slash-commands',...access==='none'?[]:['--max-turns','30']];
}

/** One stream-json user turn: the prompt as text, then each image as a base64 block. */
async function claudeImageMessage(prompt: string, images: readonly string[]): Promise<string> {
  const blocks:unknown[]=[{type:'text',text:prompt}];
  for(const image of images){
    const mediaType=imageMediaType(image);
    if(mediaType===null)throw new Error(`Image non prise en charge : ${image}`);
    blocks.push({type:'image',source:{type:'base64',media_type:mediaType,data:(await readFile(image)).toString('base64')}});
  }
  return `${JSON.stringify({type:'user',message:{role:'user',content:blocks}})}\n`;
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
  const images=options.images??[];
  const messages:HeadlessMessages={timeout:`L’agent a dépassé le délai de ${Math.round(timeoutMs/1000)} s.`,aborted:'Exécution annulée.',failed:'n’a pas répondu',...options.messages};
  signal.throwIfAborted();
  if(images.length>0&&!supportsImages(agent))throw new Error(`${agent} ne prend pas en charge les images jointes.`);
  const directory=await mkdtemp(join(tmpdir(),'cerebro-headless-'));
  try {
    const schema=join(directory,'schema.json');const output=join(directory,'result.json');const input=join(directory,'prompt.txt');
    const schemaText=JSON.stringify(options.schema);
    await writeFile(schema,schemaText);await writeFile(input,prompt,{mode:0o600});
    let args:string[];
    // What the CLI reads on stdin: the prompt, or for Claude with images the stream-json turn that embeds them.
    let stdin:string|undefined=prompt;
    if(agent==='codex') {
      args=[...codexArgs(access,schema,output,model,effort,images),'-'];
    } else {
      args=agent==='claude'?claudeArgs(access,schemaText,images.length>0):grokArgs(access,schemaText,input);
      if(agent==='claude'&&images.length>0)stdin=await claudeImageMessage(prompt,images);
      if(agent==='grok')stdin=undefined;
      args.push(...tuningArgs(agent,{model,effort}));
    }
    const env={...process.env};
    // Headless agents need CLI authentication, never Cerebro's server secrets or session helpers.
    for(const key of Object.keys(env))if(key.startsWith('CEREBRO_')||key==='CLAUDECODE')delete env[key];
    const text=await new Promise<string>((accept,reject)=>{
      signal.throwIfAborted();
      const child=spawn(agent,args,{cwd:options.cwd??directory,env,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
      let stdout='';let stderr='';let failure:Error|null=null;let killTimer:NodeJS.Timeout|undefined;
      const kill=(signal:NodeJS.Signals):void=>{try{if(process.platform==='win32')child.kill(signal);else if(child.pid)process.kill(-child.pid,signal);}catch{}};
      const stop=(reason:Error):void=>{failure=reason;if(killTimer)kill('SIGTERM');else{killTimer=killWithEscalation(kill,2000);killTimer.unref();}};
      const abort=():void=>stop(new Error(messages.aborted));
      signal.addEventListener('abort',abort,{once:true});
      const timeout=setTimeout(()=>stop(new Error(messages.timeout)),timeoutMs);timeout.unref();
      child.stdout.on('data',(data:Buffer)=>{stdout+=data.toString();if(Buffer.byteLength(stdout)>4*1024*1024)stop(new Error('Réponse de l’agent trop volumineuse.'));});
      child.stderr.on('data',(data:Buffer)=>{stderr=(stderr+data.toString()).slice(-8000);});
      const cleanup=():void=>{clearTimeout(timeout);clearTimeout(killTimer);signal.removeEventListener('abort',abort);};
      child.on('error',cause=>{cleanup();reject(cause);});
      child.on('close',code=>{cleanup();if(failure)reject(failure);else if(code!==0)reject(new Error(`${agent} ${messages.failed} : ${stderr||`code ${code}`}`));else accept(stdout);});
      child.stdin.on('error',()=>{});child.stdin.end(stdin);
    });
    signal.throwIfAborted();
    const result=agent==='codex'?decode(await readFile(output,'utf8')):agent==='claude'&&images.length>0?interpret(resultRecord(text)):decode(text);
    validateSchema(result,options.schema);
    return result;
  } finally {await rm(directory,{recursive:true,force:true});}
}
