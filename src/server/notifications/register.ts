import { registerJob } from "./jobs";
import { deliverNotification } from "./service";

registerJob("send_notification", async (p) => {
  await deliverNotification(String(p.orgId), String(p.notificationId));
});

registerJob("tick", async () => {
  const { runScheduledAutomations } = await import("../automation/service");
  await runScheduledAutomations();
});

registerJob("send_campaign", async (p) => {
  const { executeCampaign } = await import("../marketing/service");
  await executeCampaign(String(p.orgId), String(p.campaignId));
});

registerJob("retention_sweep", async () => {
  const { runRetentionForAll } = await import("../automation/service");
  await runRetentionForAll();
});
