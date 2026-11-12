import { array, boolean, number, object, parser, string } from './parse.ts';

/** Personal checklist for the displayed machine, independent of project backlogs. */
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export const TODO_TEXT_MAX = 500;

export function todoText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= TODO_TEXT_MAX ? text : null;
}

const todoSchema = object<TodoItem>({ id: string, text: string, done: boolean, createdAt: number, updatedAt: number });
export const parseTodoItem = parser(todoSchema);
export const parseTodoList = parser(array(todoSchema));
