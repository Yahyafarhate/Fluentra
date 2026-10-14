import { loadEnv } from "./load-env";
loadEnv();

async function main() {
  const { scheduleTick } = await import("../src/server/automation/service");
  const { runDueJobs } = await import("../src/server/notifications/jobs");
  console.log("worker started");
  let stop = false;
  process.on("SIGTERM", () => { stop = true; });
  process.on("SIGINT", () => { stop = true; });
  while (!stop) {
    try { await scheduleTick(); const r = await runDueJobs(50); if (r.ran) console.log(JSON.stringify({ t: new Date().toISOString(), ...r })); }
    catch (e) { console.error("worker error", e); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  process.exit(0);
}
main();
