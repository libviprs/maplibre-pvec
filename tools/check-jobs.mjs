#!/usr/bin/env node
// Reads one Playwright JSON report per job and prints the independent job results.
// A job that ran zero tests fails unless every gate it owns is declared pending; a
// skipped test fails; a missing report fails.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, "..", "tests", "conformance", "jobs.json"), "utf8"));

function walk(suites, out) {
  for (const s of suites ?? []) {
    for (const spec of s.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        out.push(last?.status ?? "failed");
      }
    }
    walk(s.suites, out);
  }
}

export function evaluateJob(job, report) {
  if (!report) return { status: "FAIL", ran: 0, reason: "no report was produced" };
  const statuses = [];
  walk(report.suites, statuses);
  if (statuses.length === 0) {
    return job.pending.length > 0
      ? { status: "PENDING", ran: 0, reason: `declared pending: ${job.pending.join(", ")}` }
      : { status: "FAIL", ran: 0, reason: "the job ran zero tests" };
  }
  if (statuses.some((s) => s === "skipped")) return { status: "FAIL", ran: statuses.length, reason: "a test was skipped" };
  if (statuses.some((s) => s !== "passed")) return { status: "FAIL", ran: statuses.length, reason: "a test failed" };
  return { status: "PASS", ran: statuses.length };
}

function main() {
  const dir = process.argv[2] ?? "job-reports";
  let exit = 0;
  for (const j of data.jobs) {
    const file = join(dir, `${j.id}.json`);
    const report = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    const pending = data.pendingGates.filter((g) => g.job === j.id).map((g) => g.name);
    const r = evaluateJob({ id: j.id, pending }, report);
    if (r.status === "FAIL") exit = 1;
    console.log(`${j.id}: ${r.status} (${j.title}, claim: ${j.claim}, ${r.ran} tests ran)${r.reason ? ` - ${r.reason}` : ""}`);
  }
  for (const g of data.pendingGates) console.log(`pending gate ${g.name} (${g.job}) waits on ${g.waitsOn}`);
  process.exit(exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
