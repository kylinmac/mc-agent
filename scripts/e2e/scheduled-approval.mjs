import assert from "node:assert/strict";
import { waitForNotification } from "./wait.mjs";

export async function confirmScheduledCreation(host, pending, permissionMode) {
  const approval = await waitForNotification(host.notifications, (event) =>
    event.method === "permissions.request" && event.params.toolName === "ScheduledTaskCreate",
  );
  assert.ok(approval, "scheduled creation requests confirmation");
  await host.call("permissions.resolve", {
    requestId: approval.params.requestId,
    decision: "allow-once",
    scheduledPermissionMode: permissionMode,
  });
  const result = await pending;
  assert.equal(result.content.task.permissionMode, permissionMode);
  return result;
}
