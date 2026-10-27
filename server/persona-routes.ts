import type { FastifyInstance } from 'fastify';
import { validatePersonaInput } from './council.ts';
import type { CerebroDatabase } from './db.ts';
import { MIN_PERSONAS, type PersonaInput } from '../shared/types.ts';

// Catalogue des personas du council, propre à la machine.
export function registerPersonaRoutes(app: FastifyInstance, db: CerebroDatabase): void {
  app.get('/api/personas', async () => db.listPersonas());
  app.post('/api/personas', async (request, reply) => {
    const result = validatePersonaInput(request.body);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    return reply.code(201).send(db.createPersona({ description: '', ...result.persona } as PersonaInput));
  });
  app.patch<{ Params: { id: string } }>('/api/personas/:id', async (request, reply) => {
    const result = validatePersonaInput(request.body, true);
    if ('error' in result) return reply.code(400).send({ error: result.error });
    return db.updatePersona(request.params.id, result.persona) ?? reply.code(404).send({ error: 'Persona introuvable' });
  });
  app.delete<{ Params: { id: string } }>('/api/personas/:id', async (request, reply) => {
    if (db.getPersona(request.params.id) === null) return reply.code(404).send({ error: 'Persona introuvable' });
    if (db.listPersonas().length <= MIN_PERSONAS) {
      return reply.code(409).send({ error: `Le catalogue doit garder au moins ${MIN_PERSONAS} personas` });
    }
    db.deletePersona(request.params.id);
    return reply.code(204).send();
  });
}
