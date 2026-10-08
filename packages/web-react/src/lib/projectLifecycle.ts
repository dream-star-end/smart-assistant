/**
 * Archive / delete / restore a project together with what hangs off it.
 *
 * A project's scheduled jobs run in the container against its work project
 * (board). Before a project is archived or deleted they must stop: its
 * enabled cron jobs are paused and its board archived (a fixed or
 * follow-session job on an archived board fails closed). Delete hands the
 * paused job ids to the server, which keeps them in the deletion manifest; a
 * restore hands them back and they are re-enabled. If any step fails, what
 * already happened is rolled back so the project is never half deleted.
 */

export type LifecycleProject = { id: string; boardProjectId?: string | null };

export type LifecycleDeps = {
  listCron: (boardProjectId: string) => Promise<Array<{ id: string; enabled?: boolean }>>;
  setCronEnabled: (id: string, enabled: boolean) => Promise<void>;
  setBoardArchived: (boardProjectId: string, archived: boolean) => Promise<void>;
  setProjectArchived: (projectId: string, archived: boolean) => Promise<void>;
  deleteProject: (projectId: string, pausedCronJobIds: string[]) => Promise<void>;
  restoreProject: (projectId: string) => Promise<{ boardProjectId: string | null; pausedCronJobIds: string[] }>;
};

async function pauseProjectCron(deps: LifecycleDeps, boardProjectId: string): Promise<string[]> {
  const jobs = await deps.listCron(boardProjectId);
  const paused: string[] = [];
  try {
    for (const job of jobs) {
      if (job.enabled === false) continue;
      await deps.setCronEnabled(job.id, false);
      paused.push(job.id);
    }
  } catch (err) {
    await resumeCron(deps, paused);
    throw err;
  }
  return paused;
}

async function resumeCron(deps: LifecycleDeps, ids: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await deps.setCronEnabled(id, true);
    } catch {
      failed.push(id); // deleted meanwhile, or the container is briefly away: reported, not fatal
    }
  }
  return failed;
}

/** Pause cron, archive the board, then delete. Rolls back on failure. */
export async function fenceAndDeleteProject(deps: LifecycleDeps, project: LifecycleProject): Promise<void> {
  const board = project.boardProjectId ?? null;
  let paused: string[] = [];
  let boardArchived = false;
  try {
    if (board) {
      paused = await pauseProjectCron(deps, board);
      await deps.setBoardArchived(board, true);
      boardArchived = true;
    }
    await deps.deleteProject(project.id, paused);
  } catch (err) {
    if (boardArchived && board) await deps.setBoardArchived(board, false).catch(() => {});
    await resumeCron(deps, paused);
    throw err;
  }
}

/** Restore, then unarchive the board and re-enable the jobs the delete paused. */
export async function restoreDeletedProject(
  deps: LifecycleDeps,
  projectId: string,
): Promise<{ cronNotResumed: string[] }> {
  const restored = await deps.restoreProject(projectId);
  if (restored.boardProjectId) await deps.setBoardArchived(restored.boardProjectId, false).catch(() => {});
  const cronNotResumed = await resumeCron(deps, restored.pausedCronJobIds);
  return { cronNotResumed };
}

/**
 * Archive: fence the board first, then hide the project. Unarchive: show the
 * project first, then reopen the board. Cron jobs stay as they were; an
 * archived board stops them firing, and they fire again once it is reopened.
 */
export async function setProjectArchivedFenced(
  deps: LifecycleDeps,
  project: LifecycleProject,
  archived: boolean,
): Promise<void> {
  const board = project.boardProjectId ?? null;
  if (archived) {
    if (board) await deps.setBoardArchived(board, true);
    try {
      await deps.setProjectArchived(project.id, true);
    } catch (err) {
      if (board) await deps.setBoardArchived(board, false).catch(() => {});
      throw err;
    }
    return;
  }
  await deps.setProjectArchived(project.id, false);
  if (board) await deps.setBoardArchived(board, false);
}
