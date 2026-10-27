import { readdirSync, readFileSync } from 'node:fs';

// Process discovery through /proc (Linux). Elsewhere every helper degrades to "nothing found".

export interface ProcessInfo {
  pid: number;
  ppid: number;
  sid: number;
  // Guards against PID reuse between the snapshot and the signal.
  startTime: string;
}

function readStat(pid: number): ProcessInfo | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is parenthesized and may contain spaces: fields start after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(fields[1]), sid: Number(fields[3]), startTime: fields[19] ?? '' };
  } catch {
    return null;
  }
}

function listPids(): number[] {
  try {
    return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return [];
  }
}

function listProcesses(): ProcessInfo[] {
  return listPids().map(readStat).filter((info): info is ProcessInfo => info !== null);
}

// The root, its descendants, and every member of a session led by one of them: a process
// that left its parent's process group (job control, `setsid` by a child) is still caught.
export function processTree(rootPid: number): ProcessInfo[] {
  const processes = listProcesses();
  const found = new Map<number, ProcessInfo>();
  const root = processes.find((info) => info.pid === rootPid);
  if (root !== undefined) found.set(rootPid, root);
  let grew = true;
  while (grew) {
    grew = false;
    for (const info of processes) {
      if (found.has(info.pid)) continue;
      if (found.has(info.ppid) || info.sid === rootPid || found.has(info.sid)) {
        found.set(info.pid, info);
        grew = true;
      }
    }
  }
  return [...found.values()];
}

export function isAlive(info: ProcessInfo): boolean {
  return readStat(info.pid)?.startTime === info.startTime;
}

export function signalProcesses(processes: Iterable<ProcessInfo>, signal: NodeJS.Signals): void {
  for (const info of processes) {
    if (!isAlive(info)) continue;
    try {
      process.kill(info.pid, signal);
    } catch {
      // Already gone or not ours.
    }
  }
}

/** SIGTERM through `kill` now, SIGKILL after `delayMs` unless the returned timer is cleared first. */
export function killWithEscalation(kill: (signal: NodeJS.Signals) => void, delayMs: number): NodeJS.Timeout {
  kill('SIGTERM');
  return setTimeout(() => kill('SIGKILL'), delayMs);
}

// Holders are found by their command line, so one survives even if its socket file is gone.
export function findProcessesByArgument(argument: string): ProcessInfo[] {
  const found: ProcessInfo[] = [];
  for (const pid of listPids()) {
    if (pid === process.pid) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(argument)) continue;
    } catch {
      continue;
    }
    const info = readStat(pid);
    if (info !== null) found.push(info);
  }
  return found;
}

// Like findProcessesByArgument, but also requires `entry` (`NAME=value`) in the initial environment, which
// a program merely naming the same file (an editor, `tail -f`) does not carry.
export function findProcessesByArgumentAndEnvironment(argument: string, entry: string): ProcessInfo[] {
  return findProcessesByArgument(argument).filter((info) => {
    try {
      return readFileSync(`/proc/${info.pid}/environ`, 'utf8').split('\0').includes(entry);
    } catch {
      return false;
    }
  });
}
