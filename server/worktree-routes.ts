import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CerebroDatabase } from './db.ts';
import { WorktreeError, WorktreeManager } from './worktrees.ts';
import { prepareCommit, executeCommitPlan, verifySnapshot } from './git-plan.ts';
import { currentPush } from './git-push.ts';
import { assertWorktreeAvailable } from './worktree-gate.ts';

export function registerWorktreeRoutes(app: FastifyInstance, db: CerebroDatabase): WorktreeManager {
  const manager=new WorktreeManager(db);
  const attempt=async(reply:FastifyReply,run:()=>Promise<unknown>,status=200):Promise<unknown>=>{
    try{return reply.code(status).send(await run());}
    catch(cause){return reply.code(cause instanceof WorktreeError?cause.statusCode:409).send({error:cause instanceof Error?cause.message:String(cause)});}
  };
  app.get('/api/worktrees',async(_request,reply)=>attempt(reply,()=>manager.list()));
  app.delete('/api/worktrees/history',async(request,reply)=>attempt(reply,async()=>{
    manager.deleteHistory((request.body as {ids?:unknown})?.ids);
  },204));
  app.get<{Params:{id:string}}>('/api/projects/:id/worktrees',async(request,reply)=>attempt(reply,()=>manager.list(request.params.id)));
  app.get<{Params:{id:string}}>('/api/worktrees/:id',async(request,reply)=>attempt(reply,()=>manager.get(request.params.id)));
  app.patch<{Params:{id:string}}>('/api/worktrees/:id/target',async(request,reply)=>attempt(reply,()=>manager.target(request.params.id,(request.body as {branch?:unknown})?.branch)));
  for(const kind of ['merge','remove'] as const){
    app.post<{Params:{id:string}}>(`/api/worktrees/:id/prepare-${kind}`,async(request,reply)=>attempt(reply,()=>manager.prepare(request.params.id,kind)));
    app.post<{Params:{id:string}}>(`/api/worktrees/:id/${kind}`,async(request,reply)=>attempt(reply,()=>manager.start(request.params.id,kind,(request.body as {token?:unknown})?.token),202));
  }
  app.post<{Params:{id:string}}>('/api/worktrees/:id/discard-inherited',async(request,reply)=>attempt(reply,()=>manager.discardInherited(request.params.id)));
  app.get<{Params:{id:string}}>('/api/worktrees/:id/git/push',async(request,reply)=>attempt(reply,async()=>{
    const view=await manager.get(request.params.id);return currentPush(view.path);
  }));
  // Orphaned worktrees still support explicit Git plans, independently of the deleted conversation.
  app.post<{Params:{id:string}}>('/api/worktrees/:id/git/prepare-commit',async(request,reply)=>attempt(reply,async()=>{
    const view=await manager.get(request.params.id);if(view.error)throw new WorktreeError(view.error);
    return prepareCommit(view.path,view);
  }));
  app.post<{Params:{id:string}}>('/api/worktrees/:id/git/commit',async(request,reply)=>attempt(reply,async()=>{
    const view=await manager.get(request.params.id);if(view.error)throw new WorktreeError(view.error);
    if(!view.managed||view.primary)throw new WorktreeError('Worktree externe : opération non disponible.');
    if(view.activeSessions.some(s=>s.status!=='idle'))throw new WorktreeError('Attendez la fin du tour de la session.');
    assertWorktreeAvailable(view.path);
    const raw=request.body as {snapshotId?:unknown};
    if(typeof raw?.snapshotId!=='string')throw new WorktreeError('snapshotId requis.',400);
    await verifySnapshot(view.path,raw.snapshotId);
    return executeCommitPlan(view.path,request.body);
  }));
  return manager;
}
