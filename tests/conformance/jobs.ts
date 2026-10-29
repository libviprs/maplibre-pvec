import data from "./jobs.json";

export type JobId = "math" | "range" | "rendering" | "interaction";
export type JobStatus = "PASS" | "FAIL" | "PENDING";

export const JOBS = data.jobs as { id: JobId; title: string; claim: string; specs: string[] }[];
export const PENDING_GATES = data.pendingGates as { name: string; job: JobId; waitsOn: string }[];

export function summariseJobs(results: Record<JobId, { status: JobStatus; ran: number }>): {
  exitCode: 0 | 1;
  lines: string[];
} {
  const lines: string[] = [];
  let exitCode: 0 | 1 = 0;
  for (const j of JOBS) {
    const r = results[j.id];
    if (r.status === "FAIL") exitCode = 1;
    lines.push(`${j.id}: ${r.status} (${j.title}, claim: ${j.claim}, ${r.ran} tests ran)`);
  }
  for (const g of PENDING_GATES) lines.push(`pending gate ${g.name} (${g.job}) waits on ${g.waitsOn}`);
  return { exitCode, lines };
}
