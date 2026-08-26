export interface AdminAuditEvent {
  action: 'grant_purchase' | 'transfer_purchase' | 'delete_purchases';
  outcome: 'success' | 'failure';
  sessionId: string;
  target: string;
  status?: number;
}
/** Emit one secret-free JSON record for ingestion by the deployment logger. */
export function writeAdminAudit(event: AdminAuditEvent): void {
  console.info(
    JSON.stringify({
      event: 'onesub.dashboard.admin_action',
      timestamp: new Date().toISOString(),
      ...event,
    }),
  );
}
