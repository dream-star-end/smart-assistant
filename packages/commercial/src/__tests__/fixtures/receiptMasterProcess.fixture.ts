/** Linux-only cleanup for this test's own spawned tree, including detached CLI children. */
import { readFileSync, readdirSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
type Identity = {
    pid: number;
    parent: number;
    started: string;
    state: string;
};
function identity(pid: number): Identity | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return { pid, state: fields[0], parent: Number(fields[1]), started: fields[19] };
    }
    catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? ''))
            return;
        throw error;
    }
}
export function rememberDescendants(root: number, known = new Map<number, Identity>()) {
    const all = readdirSync('/proc').filter(n => /^\d+$/.test(n))
        .map(n => identity(Number(n))).filter((v): v is Identity => Boolean(v));
    const parent = identity(root);
    if (parent && (!known.has(root) || known.get(root)?.started === parent.started))
        known.set(root, parent);
    let changed = true;
    while (changed) {
        changed = false;
        for (const child of all) {
            if (!known.has(child.pid) && known.has(child.parent) && known.get(child.parent)?.started === identity(child.parent)?.started) {
                known.set(child.pid, child);
                changed = true;
            }
        }
    }
    return known;
}
function alive(value: Identity) {
    const current = identity(value.pid);
    return current?.started === value.started && current.state !== 'Z';
}
export function trackOwnedTree(child: ChildProcess) {
    if (!child.pid) throw new Error('test process did not spawn');
    const pid = child.pid;
    const known = rememberDescendants(pid);
    let failure: unknown;
    const timer = setInterval(() => {
        try { rememberDescendants(pid, known); } catch (error) { failure = error; }
    }, 250);
    timer.unref();
    return { known, stop() { clearInterval(timer); if (failure) throw failure; } };
}
export async function terminateOwnedTree(child: ChildProcess, known = new Map<number, Identity>(), graceMs = 20000) {
    if (!child.pid)
        return;
    if (child.exitCode === null && child.signalCode === null) rememberDescendants(child.pid, known);
    // Let the controller rollback the PG row lock, shut down Gateway and remove its schema.
    if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
    const deadline = Date.now() + graceMs;
    while ([...known.values()].some(alive) && Date.now() < deadline) {
        rememberDescendants(child.pid, known);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const survivors = [...known.values()].filter(alive);
    for (const value of survivors.reverse()) {
        // Recheck start time immediately before signalling: never kill a reused PID.
        if (alive(value)) {
            try {
                process.kill(value.pid, 'SIGKILL');
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                    throw error;
            }
        }
    }
    if (survivors.length)
        throw new Error(`test cleanup forced ${survivors.length} owned processes; not a PASS`);
}
export async function deadline<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), milliseconds);
            })]);
    }
    finally {
        clearTimeout(timer);
    }
}
