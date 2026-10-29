export function evaluateJob(
  job: { id: string; pending: string[] },
  report: unknown,
): { status: "PASS" | "FAIL" | "PENDING"; ran: number; reason?: string };
