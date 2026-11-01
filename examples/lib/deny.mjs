// Outbound network denial for the example runners: only the local server's host passes, anything
// else is aborted and its host recorded, so a run can show that nothing tried to leave the machine.
export async function denyExternal(context, allowedHost = "127.0.0.1") {
  const blocked = new Set();
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === allowedHost || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
    blocked.add(u.hostname);
    return route.abort("blockedbyclient");
  });
  return { deniedHosts: () => [...blocked] };
}
