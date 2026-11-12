import { api, apiParsed, apiPath } from './api.ts';
import { parseTodoItem, parseTodoList, type TodoItem } from '../../shared/todos.ts';

export const getTodos = (): Promise<TodoItem[]> => apiParsed('/api/todos', parseTodoList);

export const createTodo = (text: string): Promise<TodoItem> =>
  apiParsed('/api/todos', parseTodoItem, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

export const updateTodo = (id: string, patch: Partial<Pick<TodoItem, 'text' | 'done'>>): Promise<TodoItem> =>
  apiParsed(apiPath`/api/todos/${id}`, parseTodoItem, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });

export const deleteTodo = async (id: string): Promise<void> => {
  await api(apiPath`/api/todos/${id}`, { method: 'DELETE' });
};
