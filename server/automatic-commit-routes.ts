import type { FastifyInstance, FastifyReply } from 'fastify';
import { AutomaticCommits, type AutomaticCommitContext } from './automatic-commits.ts';
import { DEFAULT_COMMIT_SETTINGS, type CerebroDatabase } from './db.ts';
import { workspaceFor } from './provenance.ts';
import { prepareCommit } from './git-plan.ts';
import { executeSessionCommit, prepareSessionGit, sessionGitContext } from './session-git.ts';
import { WorktreeError, type WorktreeManager } from './worktrees.ts';

export function registerAutomaticCommitRoutes(app:FastifyInstance,db:CerebroDatabase,worktrees:WorktreeManager):AutomaticCommits {
  const manager=new AutomaticCommits(db);
  const attempt=async(reply:FastifyReply,run:()=>Promise<unknown>,status=200):Promise<unknown>=>{
    try{return reply.code(status).send(await run());}
    catch(cause){return reply.code(cause instanceof WorktreeError?cause.statusCode:409).send({error:cause instanceof Error?cause.message:String(cause)});}
  };
  const contexts:Record<string,(id:string)=>Promise<AutomaticCommitContext>>={
    projects:async id=>{
      const project=db.getProject(id);if(!project)throw new WorktreeError('Projet introuvable.',404);
      return {scope:`projects/${id}`,path:project.path,projectId:id,sessionId:null,settings:project.commitSettings};
    },
    sessions:async id=>{
      const session=db.getSession(id);const project=session?db.getProject(session.projectId):null;
      if(!session||!project)throw new WorktreeError('Session introuvable.',404);
      const location=sessionGitContext(db,id);
      if(location.mode==='removed')throw new WorktreeError('La copie de travail de cette conversation a été supprimée.');
      return {scope:`sessions/${id}`,path:location.path,projectId:project.id,sessionId:id,settings:project.commitSettings,
        prepare:()=>prepareSessionGit(db,id),execute:plan=>executeSessionCommit(id,plan)};
    },
    worktrees:async id=>{
      const view=await worktrees.get(id);
      if(view.error)throw new WorktreeError(view.error);
      if(!view.managed||view.primary)throw new WorktreeError('Worktree externe ou principal : utilisez l’action du projet.');
      const project=view.projectId?db.getProject(view.projectId):null;
      const context:AutomaticCommitContext={scope:`worktrees/${id}`,path:view.path,projectId:project?.id??null,sessionId:view.session?.id??null,settings:project?.commitSettings??view.commitSettings??{...DEFAULT_COMMIT_SETTINGS}};
      if(view.session){context.prepare=()=>prepareSessionGit(db,view.session!.id);context.execute=plan=>executeSessionCommit(view.session!.id,plan);}
      else if(view.sessionId){
        const workspace=workspaceFor(db,view.sessionId);
        context.prepare=async()=>{const snapshot=await prepareCommit(view.path,workspace??view);return {...snapshot,files:snapshot.files.map(file=>workspace?.initialDirty.includes(file.path)?{...file,warnings:[...file.warnings,'Modification présente avant la création du worktree : vérification manuelle requise.']}:file)};};
      }
      return context;
    },
  };
  for(const [scope,context] of Object.entries(contexts)){
    app.post<{Params:{id:string}}>(`/api/${scope}/:id/git/auto-commit`,async(request,reply)=>attempt(reply,async()=>{
      const body=request.body as {requestId?:unknown;push?:unknown;reviewed?:unknown;strategy?:unknown};
      return manager.start(await context(request.params.id),body?.requestId,body?.push??true,body?.reviewed,body?.strategy);
    },202));
  }
  app.get<{Params:{id:string}}>('/api/git/auto-commits/:id',async(request,reply)=>{
    const operation=manager.get(request.params.id);return operation?reply.send(operation):reply.code(404).send({error:'Opération introuvable.'});
  });
  app.post<{Params:{id:string}}>('/api/git/auto-commits/:id/cancel',async(request,reply)=>attempt(reply,async()=>manager.cancel(request.params.id)));
  return manager;
}
