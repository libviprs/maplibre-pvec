import { describe, expect, it } from "vitest";
import { JOBS, PENDING_GATES, summariseJobs } from "../conformance/jobs";
import { evaluateJob } from "../../tools/check-jobs.mjs";

const spec = (status: string) => ({ title: "t", tests: [{ results: [{ status }] }] });
const report = (...statuses: string[]) => ({ suites: [{ title: "f", specs: statuses.map(spec), suites: [] }] });

describe("#10 the four conformance jobs", () => {
  it("are mathematical semantics, range decoding, rendering snapshots and interaction", () => {
    expect(JOBS.map((j) => j.id)).toEqual(["math", "range", "rendering", "interaction"]);
    expect(JOBS.find((j) => j.id === "rendering")!.claim).toBe("display fidelity");
    expect(JOBS.find((j) => j.id === "math")!.claim).toBe("structural and geometric exactness");
  });

  it("list every pending gate by name with the issue it waits on", () => {
    expect(PENDING_GATES.length).toBeGreaterThanOrEqual(4);
    for (const g of PENDING_GATES) {
      expect(g.name).toBeTruthy();
      expect(g.waitsOn).toMatch(/#\d+/);
      expect(JOBS.map((j) => j.id)).toContain(g.job);
    }
    expect(PENDING_GATES.map((g) => g.name)).toEqual(expect.arrayContaining(["pipeline", "tier0"]));
  });

  it("fail a job that ran zero tests unless every gate it owns is declared pending", () => {
    expect(evaluateJob({ id: "range", pending: [] }, report()).status).toBe("FAIL");
    expect(evaluateJob({ id: "rendering", pending: ["pipeline"] }, report()).status).toBe("PENDING");
  });

  it("fail a job with a skipped test, a failed test or a missing report", () => {
    expect(evaluateJob({ id: "range", pending: [] }, report("passed", "skipped")).status).toBe("FAIL");
    expect(evaluateJob({ id: "range", pending: [] }, report("passed", "failed")).status).toBe("FAIL");
    expect(evaluateJob({ id: "range", pending: [] }, null).status).toBe("FAIL");
    expect(evaluateJob({ id: "range", pending: [] }, report("passed", "passed")).status).toBe("PASS");
  });

  it("report each job independently, so a rendering failure is not covered by a math pass", () => {
    const text = summariseJobs({
      math: { status: "PASS", ran: 3 },
      range: { status: "PASS", ran: 4 },
      rendering: { status: "FAIL", ran: 2 },
      interaction: { status: "PENDING", ran: 0 },
    });
    expect(text.exitCode).toBe(1);
    expect(text.lines.join("\n")).toContain("rendering: FAIL");
    expect(text.lines.join("\n")).toContain("display fidelity");
    expect(summariseJobs({ math: { status: "PASS", ran: 1 }, range: { status: "PASS", ran: 1 }, rendering: { status: "PENDING", ran: 0 }, interaction: { status: "PENDING", ran: 0 } }).exitCode).toBe(0);
  });
});
