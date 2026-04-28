#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { setupInputSchema, runSetup } from './tools/setup.js';
import { addPaywallInputSchema, runAddPaywall } from './tools/add-paywall.js';
import { checkStatusInputSchema, runCheckStatus } from './tools/check-status.js';
import { troubleshootInputSchema, runTroubleshoot } from './tools/troubleshoot.js';
import { createProductInputSchema, runCreateProduct } from './tools/create-product.js';
import { listProductsInputSchema, runListProducts } from './tools/list-products.js';
import { viewSubscribersInputSchema, runViewSubscribers } from './tools/view-subscribers.js';
import { simulatePurchaseInputSchema, runSimulatePurchase } from './tools/simulate-purchase.js';
import { simulateWebhookInputSchema, runSimulateWebhook } from './tools/simulate-webhook.js';
import { inspectStateInputSchema, runInspectState } from './tools/inspect-state.js';
import { manageProductInputSchema, runManageProduct } from './tools/manage-product.js';

const server = new McpServer({
  name: 'onesub-mcp',
  version: '0.1.0',
});

server.tool(
  'onesub_setup',
  'Analyze the current project and generate onesub integration code. Detects framework (Expo, React Native CLI, bare RN) and generates appropriate setup code.',
  {
    projectPath: setupInputSchema.projectPath,
    productId: setupInputSchema.productId,
    price: setupInputSchema.price,
    serverUrl: z
      .string()
      .url()
      .optional()
      .describe('URL where @onesub/server is hosted (default: http://localhost:4100)'),
  },
  async (args) => {
    return runSetup(args);
  },
);

server.tool(
  'onesub_add_paywall',
  'Generate a customized paywall screen for the app.',
  {
    title: addPaywallInputSchema.title,
    features: addPaywallInputSchema.features,
    price: addPaywallInputSchema.price,
    style: z
      .enum(['minimal', 'gradient', 'card'])
      .optional()
      .describe("Visual style of the paywall screen: 'minimal' (default), 'gradient', or 'card'"),
  },
  async (args) => {
    return runAddPaywall(args);
  },
);

server.tool(
  'onesub_check_status',
  'Check a user\'s subscription status via the onesub server.',
  {
    serverUrl: checkStatusInputSchema.serverUrl,
    userId: checkStatusInputSchema.userId,
  },
  async (args) => {
    return runCheckStatus(args);
  },
);

server.tool(
  'onesub_troubleshoot',
  'Diagnose common IAP issues and provide solutions.',
  {
    issue: troubleshootInputSchema.issue,
    platform: z
      .enum(['ios', 'android', 'both'])
      .optional()
      .describe("Target platform: 'ios', 'android', or 'both' (default)"),
    logs: troubleshootInputSchema.logs,
  },
  async (args) => {
    return runTroubleshoot(args);
  },
);

server.tool(
  'onesub_create_product',
  'Create a subscription, consumable, or non-consumable IAP product on Apple App Store Connect and/or Google Play Console. Accepts either appleAppId (numeric) or appleBundleId for Apple. Automatically sets the price and adds Korean localization for KRW products. Use productType to select subscription (default), consumable, or non_consumable.',
  {
    platform: createProductInputSchema.platform,
    productId: createProductInputSchema.productId,
    name: createProductInputSchema.name,
    price: createProductInputSchema.price,
    currency: createProductInputSchema.currency,
    productType: createProductInputSchema.productType,
    period: createProductInputSchema.period,
    extraRegions: createProductInputSchema.extraRegions,
    appleKeyId: createProductInputSchema.appleKeyId,
    appleIssuerId: createProductInputSchema.appleIssuerId,
    applePrivateKey: createProductInputSchema.applePrivateKey,
    appleAppId: createProductInputSchema.appleAppId,
    appleBundleId: createProductInputSchema.appleBundleId,
    googlePackageName: createProductInputSchema.googlePackageName,
    googleServiceAccountKey: createProductInputSchema.googleServiceAccountKey,
  },
  async (args) => {
    return runCreateProduct(args);
  },
);

server.tool(
  'onesub_list_products',
  'List all IAP products (subscriptions, consumables, non-consumables) registered on Apple App Store Connect and/or Google Play Console',
  {
    platform: listProductsInputSchema.platform,
    appleKeyId: listProductsInputSchema.appleKeyId,
    appleIssuerId: listProductsInputSchema.appleIssuerId,
    applePrivateKey: listProductsInputSchema.applePrivateKey,
    appleAppId: listProductsInputSchema.appleAppId,
    googlePackageName: listProductsInputSchema.googlePackageName,
    googleServiceAccountKey: listProductsInputSchema.googleServiceAccountKey,
  },
  async (args) => {
    return runListProducts(args);
  },
);

server.tool(
  'onesub_view_subscribers',
  'View current subscription status and subscriber count from the onesub server',
  {
    serverUrl: viewSubscribersInputSchema.serverUrl,
    userId: viewSubscribersInputSchema.userId,
  },
  async (args) => {
    return runViewSubscribers(args);
  },
);

server.tool(
  'onesub_simulate_purchase',
  "Simulate a purchase against a onesub server running in mockMode (started via `npx @onesub/cli dev`). Drives the full validation flow with no real App Store / Play Store credentials — sends a MOCK_* receipt that the server's mock provider decodes into the chosen outcome (new / revoked / expired / invalid / network_error / sandbox). Use to exercise app error paths, verify integration, or drive end-to-end test scenarios from an AI agent.",
  {
    serverUrl: simulatePurchaseInputSchema.serverUrl,
    userId: simulatePurchaseInputSchema.userId,
    productId: simulatePurchaseInputSchema.productId,
    platform: simulatePurchaseInputSchema.platform,
    type: simulatePurchaseInputSchema.type,
    scenario: simulatePurchaseInputSchema.scenario,
  },
  async (args) => {
    return runSimulatePurchase(args);
  },
);

server.tool(
  'onesub_simulate_webhook',
  "Send a simulated Apple or Google webhook notification to an onesub server to test lifecycle transitions without real store credentials. Builds a fake (unsigned) payload and POSTs it to /onesub/webhook/apple or /onesub/webhook/google. Requires the server to have skipJwsVerification: true (set automatically by `npx @onesub/cli dev`). Apple types: SUBSCRIBED, DID_RENEW, DID_RECOVER, OFFER_REDEEMED, DID_FAIL_TO_RENEW, GRACE_PERIOD_EXPIRED, EXPIRED, REFUND, REVOKE. Google types: purchased, renewed, recovered, restarted, canceled, revoked, expired, on_hold, grace_period, paused, price_change_confirmed.",
  {
    serverUrl: simulateWebhookInputSchema.serverUrl,
    platform: simulateWebhookInputSchema.platform,
    notificationType: simulateWebhookInputSchema.notificationType,
    transactionId: simulateWebhookInputSchema.transactionId,
    productId: simulateWebhookInputSchema.productId,
    subtype: simulateWebhookInputSchema.subtype,
    bundleId: simulateWebhookInputSchema.bundleId,
    packageName: simulateWebhookInputSchema.packageName,
    expiresInDays: simulateWebhookInputSchema.expiresInDays,
  },
  async (args) => {
    return runSimulateWebhook(args);
  },
);

server.tool(
  'onesub_inspect_state',
  "Read the current subscription + one-time purchase state for a user from the onesub server in one call. Useful after simulating purchases to confirm the server recorded them, or when debugging 'isActive' mismatches.",
  {
    serverUrl: inspectStateInputSchema.serverUrl,
    userId: inspectStateInputSchema.userId,
  },
  async (args) => {
    return runInspectState(args);
  },
);

server.tool(
  'onesub_manage_product',
  'Update or delete an existing IAP product on Apple App Store Connect and/or Google Play Console. Use action="update" to rename a product, or action="delete" to remove it. Note: Apple products that are already approved (READY_FOR_SALE) cannot be deleted via the API — use App Store Connect to remove them manually.',
  {
    action: manageProductInputSchema.action,
    platform: manageProductInputSchema.platform,
    productId: manageProductInputSchema.productId,
    productType: manageProductInputSchema.productType,
    name: manageProductInputSchema.name,
    appleKeyId: manageProductInputSchema.appleKeyId,
    appleIssuerId: manageProductInputSchema.appleIssuerId,
    applePrivateKey: manageProductInputSchema.applePrivateKey,
    appleAppId: manageProductInputSchema.appleAppId,
    appleBundleId: manageProductInputSchema.appleBundleId,
    googlePackageName: manageProductInputSchema.googlePackageName,
    googleServiceAccountKey: manageProductInputSchema.googleServiceAccountKey,
  },
  async (args) => {
    return runManageProduct(args);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`onesub-mcp fatal error: ${String(err)}\n`);
  process.exit(1);
});
