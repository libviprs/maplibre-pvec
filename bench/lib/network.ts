import type { BrowserContext } from "@playwright/test";

// Allow the local fixture origin only. Anything else is aborted and its host recorded, so a run
// can show that nothing tried to leave the machine.
export async function denyExternal(context: BrowserContext, allowedHost: string): Promise<{ hosts(): string[] }> {
  const blocked = new Set<string>();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === allowedHost || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    blocked.add(u.hostname);
    return route.abort("blockedbyclient");
  });
  return { hosts: () => [...blocked] };
}
