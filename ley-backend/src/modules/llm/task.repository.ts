import { db } from "./db.js";

export interface Task {
  id: number;
  title: string;
  status: 'pending' | 'completed';
  created_at: number;
  updated_at: number;
}

export function createTask(title: string): Task {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO tasks (title, status, created_at, updated_at)
    VALUES (?, 'pending', ?, ?)
  `);
  const info = stmt.run(title, now, now);

  return {
    id: Number(info.lastInsertRowid),
    title,
    status: 'pending',
    created_at: now,
    updated_at: now,
  };
}

export function listTasks(status?: 'pending' | 'completed'): Task[] {
  if (status) {
    const stmt = db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC`);
    return stmt.all(status) as Task[];
  }
  const stmt = db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`);
  return stmt.all() as Task[];
}

export function completeTask(id: number): boolean {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE tasks
    SET status = 'completed', updated_at = ?
    WHERE id = ?
  `);
  const info = stmt.run(now, id);
  return info.changes > 0;
}
