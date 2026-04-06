#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { setupInputSchema, runSetup } from './tools/setup.js';
import { addPaywallInputSchema, runAddPaywall } from './tools/add-paywall.js';
import { checkStatusInputSchema, runCheckStatus } from './tools/check-status.js';
import { troubleshootInputSchema, runTroubleshoot } from './tools/troubleshoot.js';

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

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`onesub-mcp fatal error: ${String(err)}\n`);
  process.exit(1);
});
