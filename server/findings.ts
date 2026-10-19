import { createHash, randomUUID } from 'node:crypto';
import type { CerebroDatabase, Task } from './db.ts';
export interface Finding { id:string; title:string; severity:'critical'|'high'|'medium'|'low'; file:string; line:number; problem:string; scenario:string; expectedFix:string; dependsOn:string[]; taskDependencies:string[] }
export interface FindingReport { title:string; findings:Finding[] }
export interface SavedReport extends FindingReport { id:string; sessionId:string; createdAt:number; epicId:string|null; imported:Record<string,string> }
export const FINDING_INSTRUCTIONS='Si des findings sont établis, publie aussi un JSON structuré via `cerebro-findings` sur son entrée standard : {title,findings:[{id,title,severity:"critical|high|medium|low",file,line,problem,scenario,expectedFix,dependsOn:[],taskDependencies:[]}]}. dependsOn référence des ids de findings ; taskDependencies des ids existants du backlog. Chaque finding doit être autonome et étayé. Cerebro permettra leur sélection et leur enregistrement direct dans le backlog. Pour un texte libre ou incomplet, conserve le flux habituel de discussion/reformulation. Ne crée pas de tâches sans demande explicite.';
function string(v:unknown,max:number):string{if(typeof v!=='string'||!v.trim()||v.length>max)throw new Error('Champ de finding absent ou trop long.');return v.trim();}
export function parseReport(raw:unknown):FindingReport{
  if(Buffer.byteLength(JSON.stringify(raw)??'')>1024*1024)throw new Error('Rapport trop volumineux (1 Mio).');
  const r=raw as FindingReport;
  if(!r||!Array.isArray(r.findings)||!r.findings.length||r.findings.length>100)throw new Error('Entre 1 et 100 findings requis.');
  const findings=r.findings.map(f=>{
    if(!f||!['critical','high','medium','low'].includes(f.severity)||!Number.isInteger(f.line)||f.line<1)throw new Error('Gravité ou ligne invalide.');
    const dependencies=(v:unknown):string[]=>{if(v===undefined)return [];if(!Array.isArray(v)||!v.every(i=>typeof i==='string'&&i.length>0&&i.length<=200))throw new Error('Dépendances invalides.');return [...new Set(v)];};
    return {id:string(f.id,100),title:string(f.title,200),severity:f.severity,file:string(f.file,1000),line:f.line,problem:string(f.problem,5000),scenario:string(f.scenario,5000),expectedFix:string(f.expectedFix,5000),dependsOn:dependencies(f.dependsOn),taskDependencies:dependencies(f.taskDependencies)};
  });
  const ids=new Map(findings.map(f=>[f.id,f]));if(ids.size!==findings.length)throw new Error('Identifiants de findings répétés.');
  const visited=new Set<string>();
  const visit=(id:string,path:Set<string>):void=>{if(visited.has(id))return;if(path.has(id))throw new Error('Cycle entre findings.');const f=ids.get(id);if(!f)throw new Error('Dépendance de finding inconnue.');f.dependsOn.forEach(dep=>visit(dep,new Set([...path,id])));visited.add(id);};
  findings.forEach(f=>visit(f.id,new Set()));return {title:string(r.title,200),findings};
}
export function saveReport(db:CerebroDatabase,sessionId:string,raw:unknown):SavedReport{
  if(!db.getSession(sessionId))throw new Error('Session introuvable.');
  const report=parseReport(raw);const digest=createHash('sha256').update(JSON.stringify(report)).digest('hex');
  db.connection.prepare('INSERT OR IGNORE INTO review_reports (id,session_id,digest,data,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),sessionId,digest,JSON.stringify(report),Date.now());
  return listReports(db,sessionId).find(r=>createHash('sha256').update(JSON.stringify({title:r.title,findings:r.findings})).digest('hex')===digest)!;
}
export function listReports(db:CerebroDatabase,sessionId:string):SavedReport[]{
  const rows=db.connection.prepare('SELECT * FROM review_reports WHERE session_id=? ORDER BY created_at').all(sessionId) as unknown as {id:string;session_id:string;data:string;created_at:number;epic_id:string|null}[];
  return rows.map(row=>({...JSON.parse(row.data),id:row.id,sessionId:row.session_id,createdAt:row.created_at,epicId:row.epic_id,imported:Object.fromEntries((db.connection.prepare('SELECT finding_id,task_id FROM finding_imports WHERE report_id=?').all(row.id) as {finding_id:string;task_id:string}[]).map(r=>[r.finding_id,r.task_id]))}));
}
export function importFindings(db:CerebroDatabase,sessionId:string,reportId:string,selection:unknown){
  if(!Array.isArray(selection)||!selection.length||!selection.every(s=>typeof s==='string'))throw new Error('Sélection de findings invalide.');
  const report=listReports(db,sessionId).find(r=>r.id===reportId);if(!report)throw new Error('Rapport introuvable.');
  const session=db.getSession(sessionId)!;const selected=[...new Set(selection)].map(id=>{const f=report.findings.find(f=>f.id===id);if(!f)throw new Error('Finding inconnu.');return f;});
  const wanted=new Set(selected.map(f=>f.id));
  for(const f of selected){
    if(report.imported[f.id]&&!db.getTask(report.imported[f.id]))throw new Error('Une tâche importée a été supprimée : vérifiez le backlog avant réimport.');
    if(f.dependsOn.some(id=>!wanted.has(id)&&!report.imported[id]))throw new Error('Sélectionnez aussi les findings prérequis.');
    if(f.taskDependencies.some(id=>db.getTask(id)?.projectId!==session.projectId))throw new Error('Dépendance externe introuvable dans le projet.');
  }
  db.connection.exec('BEGIN IMMEDIATE');
  try{
    let epic=report.epicId?db.getEpic(report.epicId):null;
    if(report.epicId&&!epic)throw new Error('L’epic importé a été supprimé : vérifiez les tâches avant de réimporter.');
    if(!epic){epic=db.createEpic(session.projectId,report.title,`Findings structurés de la session ${sessionId}, rapport ${reportId}.`,sessionId);db.connection.prepare('UPDATE review_reports SET epic_id=? WHERE id=?').run(epic.id,reportId);}
    const imported={...report.imported};const created:Task[]=[];
    for(const f of selected){
      if(imported[f.id])continue;
      const text=`${f.title} [${f.severity}]\n\nSource : ${f.file}:${f.line}\nProblème : ${f.problem}\nScénario : ${f.scenario}\nCorrectif attendu : ${f.expectedFix}\nSession source : ${sessionId}`;
      if(text.length>20_000)throw new Error('Tâche trop volumineuse.');
      const task=db.createTask(session.projectId,text,sessionId,epic.id);created.push(task);imported[f.id]=task.id;
      db.connection.prepare('INSERT INTO finding_imports (report_id,finding_id,task_id) VALUES (?,?,?)').run(reportId,f.id,task.id);
    }
    for(const f of selected.filter(f=>created.some(t=>t.id===imported[f.id])))for(const dep of [...f.dependsOn.map(id=>imported[id]),...f.taskDependencies])db.connection.prepare('INSERT OR IGNORE INTO task_dependencies (task_id,depends_on_id) VALUES (?,?)').run(imported[f.id],dep);
    db.connection.exec('COMMIT');return {epic,tasks:created.map(t=>db.getTask(t.id)!),imported};
  }catch(cause){db.connection.exec('ROLLBACK');throw cause;}
}
