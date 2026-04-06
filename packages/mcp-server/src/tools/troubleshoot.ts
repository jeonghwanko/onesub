import { z } from 'zod';
import { ROUTES } from '@onesub/shared';

export const troubleshootInputSchema = {
  issue: z
    .string()
    .min(1)
    .describe(
      'Describe the problem (e.g. "Purchase failed", "Receipt validation failed", "Paywall showing for subscribed user")',
    ),
  platform: z
    .enum(['ios', 'android', 'both'])
    .optional()
    .default('both')
    .describe('Target platform'),
  logs: z
    .string()
    .optional()
    .describe('Any relevant error logs or stack traces to help with diagnosis'),
};

interface DiagnosisResult {
  diagnosis: string;
  severity: 'info' | 'warning' | 'error';
  steps: string[];
  references?: string[];
}

export async function runTroubleshoot(args: {
  issue: string;
  platform?: 'ios' | 'android' | 'both';
  logs?: string;
}): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const platform = args.platform ?? 'both';
  const issueLower = args.issue.toLowerCase();

  const diagnoses = diagnose(issueLower, platform, args.logs);
  const text = formatOutput({ issue: args.issue, platform, logs: args.logs, diagnoses });

  return { content: [{ type: 'text', text }] };
}

function diagnose(
  issueLower: string,
  platform: 'ios' | 'android' | 'both',
  logs?: string,
): DiagnosisResult[] {
  const results: DiagnosisResult[] = [];
  const logsLower = (logs ?? '').toLowerCase();

  // --- Purchase failed ---
  if (
    issueLower.includes('purchase fail') ||
    issueLower.includes('purchase error') ||
    issueLower.includes('cannot purchase') ||
    issueLower.includes('buy fail')
  ) {
    results.push(...diagnosePurchaseFailed(platform, logsLower));
  }

  // --- Receipt / validation failed ---
  if (
    issueLower.includes('receipt') ||
    issueLower.includes('validat') ||
    issueLower.includes('verify fail') ||
    logsLower.includes('invalid receipt') ||
    logsLower.includes('21007') ||
    logsLower.includes('21002')
  ) {
    results.push(...diagnoseReceiptValidation(platform, logsLower));
  }

  // --- Subscription not active after purchase ---
  if (
    issueLower.includes('not active') ||
    issueLower.includes('still not subscribed') ||
    issueLower.includes('status not updat') ||
    issueLower.includes('subscription not show')
  ) {
    results.push(...diagnoseNotActiveAfterPurchase(platform));
  }

  // --- Paywall showing for subscribed user ---
  if (
    issueLower.includes('paywall') ||
    issueLower.includes('still see paywall') ||
    issueLower.includes('premium not unlock') ||
    issueLower.includes('subscribed but')
  ) {
    results.push(...diagnosePaywallForSubscribedUser(platform));
  }

  // --- Restore not working ---
  if (issueLower.includes('restore') || issueLower.includes('recover purchase')) {
    results.push(...diagnoseRestoreNotWorking(platform));
  }

  // --- Server errors in logs ---
  if (logsLower.includes('econnrefused') || logsLower.includes('network error') || logsLower.includes('fetch failed')) {
    results.push(diagnoseNetworkError());
  }

  // --- No matching diagnosis ---
  if (results.length === 0) {
    results.push(diagnoseGeneral());
  }

  return results;
}

function diagnosePurchaseFailed(
  platform: 'ios' | 'android' | 'both',
  logsLower: string,
): DiagnosisResult[] {
  const results: DiagnosisResult[] = [];

  const sandboxSteps: string[] = [];
  const configSteps: string[] = [];

  if (platform === 'ios' || platform === 'both') {
    sandboxSteps.push(
      'iOS: Make sure you are signed in with a **Sandbox tester account** on the test device (Settings → App Store → sign out of your real account, then sign in with sandbox account).',
      'iOS: Sandbox accounts are created in App Store Connect → Users and Access → Sandbox Testers.',
      'iOS: The sandbox account email must NOT be a real Apple ID.',
    );
    configSteps.push(
      'iOS: Verify the product ID in your onesub config matches exactly what is in App Store Connect (case-sensitive).',
      'iOS: Ensure the subscription product status is "Ready to Submit" or "Approved" in App Store Connect.',
      'iOS: Check that your app\'s bundle ID matches the one in App Store Connect.',
      'iOS: Run on a physical device — the iOS Simulator does not support real IAP.',
    );
  }

  if (platform === 'android' || platform === 'both') {
    sandboxSteps.push(
      'Android: Use a **license tester** account (Google Play Console → Setup → License testing).',
      'Android: The tester account must be different from the account that owns the Play Console.',
      'Android: The app must be uploaded to Play Console (at least Internal Testing track) for IAP to work.',
    );
    configSteps.push(
      'Android: Verify the product ID matches exactly in Google Play Console → Monetize → Subscriptions.',
      'Android: Ensure the subscription is "Active" in Google Play Console (not draft).',
      'Android: The app version used for testing must be a signed APK/AAB uploaded to Play Console.',
    );
  }

  results.push({
    diagnosis: 'Sandbox / test account issue',
    severity: 'warning',
    steps: sandboxSteps,
    references: ['https://developer.apple.com/documentation/storekit/in-app_purchase/testing_in-app_purchases_with_sandbox'],
  });

  results.push({
    diagnosis: 'Product configuration issue',
    severity: 'warning',
    steps: configSteps,
  });

  if (logsLower.includes('e_unknown') || logsLower.includes('billing unavailable')) {
    results.push({
      diagnosis: 'Billing service unavailable',
      severity: 'error',
      steps: [
        'Android: This usually means the device does not have Google Play Services or billing service is not ready.',
        'Android: Check that the device has Google Play installed and updated.',
        'Android: Ensure `react-native-iap` or `expo-in-app-purchases` is correctly set up and linked.',
        'Restart the app completely after linking native modules.',
      ],
    });
  }

  return results;
}

function diagnoseReceiptValidation(
  platform: 'ios' | 'android' | 'both',
  logsLower: string,
): DiagnosisResult[] {
  const results: DiagnosisResult[] = [];

  const iosSteps: string[] = [];
  const androidSteps: string[] = [];
  const serverSteps: string[] = [
    `Verify the onesub server is running and the \`${ROUTES.VALIDATE}\` endpoint is reachable.`,
    'Check the server logs for the exact validation error.',
    'Make sure `APPLE_SHARED_SECRET` / `GOOGLE_SERVICE_ACCOUNT_KEY` environment variables are set.',
  ];

  if (platform === 'ios' || platform === 'both') {
    if (logsLower.includes('21007')) {
      iosSteps.push(
        '**Error 21007**: Receipt is from the sandbox but was sent to the production endpoint. The onesub server automatically handles this — check your server version.',
      );
    }
    if (logsLower.includes('21002')) {
      iosSteps.push(
        '**Error 21002**: The receipt data was malformed. Ensure you are sending the full base64 receipt string without modification.',
      );
    }
    iosSteps.push(
      'Verify `APPLE_SHARED_SECRET` in server env matches the shared secret in App Store Connect → App Information.',
      'For StoreKit 2: verify `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, and `APPLE_PRIVATE_KEY` are set correctly.',
      'The private key should include the full PEM content with newlines as `\\n`.',
    );
  }

  if (platform === 'android' || platform === 'both') {
    androidSteps.push(
      'Verify the service account JSON key is valid and the account has the "Android Publisher" IAM role.',
      'Check that `GOOGLE_SERVICE_ACCOUNT_KEY` is set as a JSON string (not a file path).',
      'Ensure the Google Play Android Developer API is enabled in the Google Cloud Console for your project.',
      'The service account must be linked to your Play Console app (Play Console → Setup → API access).',
    );
  }

  results.push({
    diagnosis: 'Receipt validation configuration',
    severity: 'error',
    steps: [
      ...serverSteps,
      ...(platform !== 'android' ? iosSteps : []),
      ...(platform !== 'ios' ? androidSteps : []),
    ],
    references: [
      'https://developer.apple.com/documentation/appstorereceipts/validating_receipts_with_the_app_store',
    ],
  });

  return results;
}

function diagnoseNotActiveAfterPurchase(platform: 'ios' | 'android' | 'both'): DiagnosisResult[] {
  const steps: string[] = [
    'Check whether the `onesub_check_status` tool shows the subscription as active after purchase.',
    `Verify the \`${ROUTES.VALIDATE}\` endpoint on your server received and processed the purchase receipt.`,
    'Check server logs for the validation result immediately after purchase.',
    'Confirm the client calls `purchase()` from `useSubscription()` — this automatically sends the receipt to your server.',
  ];

  if (platform === 'ios' || platform === 'both') {
    steps.push(
      'iOS: After a successful sandbox purchase, receipt validation can occasionally take a few seconds. Add a brief polling retry on the client.',
    );
  }

  if (platform === 'android' || platform === 'both') {
    steps.push(
      'Android: Google Play purchases require acknowledgment within 3 days or they are refunded. The onesub server acknowledges automatically during validation — verify your server processed the purchase.',
    );
  }

  steps.push(
    'Check the database — confirm a subscription record was written with `status = "active"`.',
    'If the record exists but `isActive` returns false in the app, the client may be caching an old status. Force a refresh by calling the `useSubscription()` `refresh()` method.',
  );

  return [
    {
      diagnosis: 'Subscription not reflected after successful purchase',
      severity: 'warning',
      steps,
    },
  ];
}

function diagnosePaywallForSubscribedUser(platform: 'ios' | 'android' | 'both'): DiagnosisResult[] {
  const steps: string[] = [
    `Run \`onesub_check_status\` with the user's ID to confirm the server sees the subscription as active.`,
    'If the server reports active but the app shows the paywall, the client is not fetching the latest status.',
    'Make sure `OneSubProvider` wraps your entire app — it must be an ancestor of all screens that call `useSubscription()`.',
    'Call the `refresh()` method returned by `useSubscription()` when the app becomes active (use `AppState` listener).',
    'Check that the `userId` passed to `OneSubProvider` (or to the purchase flow) matches the `userId` stored server-side.',
    'If using React Navigation, confirm the paywall screen does not check `isActive` before the provider has finished loading (`isLoading` guard).',
  ];

  if (platform === 'ios' || platform === 'both') {
    steps.push(
      'iOS: After restoring purchases, call `restore()` from `useSubscription()` to re-validate with the server.',
    );
  }

  return [
    {
      diagnosis: 'Paywall shown to active subscriber — likely a stale status',
      severity: 'warning',
      steps,
    },
  ];
}

function diagnoseRestoreNotWorking(platform: 'ios' | 'android' | 'both'): DiagnosisResult[] {
  const steps: string[] = [
    'Call `restore()` from `useSubscription()` — this triggers platform restore and re-validates receipts server-side.',
    'The user must be signed into the **same account** that originally made the purchase.',
  ];

  if (platform === 'ios' || platform === 'both') {
    steps.push(
      'iOS: Restore only works for non-consumable or subscription products. Verify your product type.',
      'iOS: In sandbox, restore works if the sandbox account previously purchased the product.',
    );
  }

  if (platform === 'android' || platform === 'both') {
    steps.push(
      'Android: Subscriptions are tied to the Google account. Sign in with the purchasing account.',
      'Android: Past purchases are available via the Play Billing API automatically — if restore fails, check the service account permissions.',
    );
  }

  return [
    {
      diagnosis: 'Restore purchases not working',
      severity: 'info',
      steps,
    },
  ];
}

function diagnoseNetworkError(): DiagnosisResult {
  return {
    diagnosis: 'Network error — cannot reach onesub server',
    severity: 'error',
    steps: [
      'Ensure the onesub server is running (`node dist/index.js`).',
      'Verify the `serverUrl` in your `OneSubProvider` config points to the correct host and port.',
      'If testing on a physical device, use the machine\'s local IP (not `localhost`) — e.g., `http://192.168.1.100:4100`.',
      'Check firewall rules on the server machine allow inbound connections on the onesub port.',
      'In production, ensure the server URL uses HTTPS and a valid certificate.',
    ],
  };
}

function diagnoseGeneral(): DiagnosisResult {
  return {
    diagnosis: 'General debugging checklist',
    severity: 'info',
    steps: [
      'Run `onesub_check_status` to verify the server can return subscription data.',
      'Check that `OneSubProvider` is wrapping your app root with correct `serverUrl` and `productId`.',
      'Enable verbose logging in `@onesub/server` by setting `DEBUG=onesub:*` environment variable.',
      'Check the onesub server logs for any request/response errors.',
      'Review the App Store Connect / Google Play Console for any account or product status issues.',
      'Make sure you are testing on a physical device (not a simulator) for real IAP flows.',
      `Common endpoints to verify manually:
  - Status:   GET  {serverUrl}${ROUTES.STATUS}?userId=<id>
  - Validate: POST {serverUrl}${ROUTES.VALIDATE}`,
    ],
    references: ['https://github.com/onesub/onesub'],
  };
}

function formatOutput(opts: {
  issue: string;
  platform: 'ios' | 'android' | 'both';
  logs?: string;
  diagnoses: DiagnosisResult[];
}): string {
  const { issue, platform, logs, diagnoses } = opts;
  const platformLabel =
    platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'iOS + Android';

  const lines: string[] = [
    '# onesub Troubleshooter',
    '',
    `**Issue:** ${issue}`,
    `**Platform:** ${platformLabel}`,
  ];

  if (logs) {
    lines.push('', '**Logs provided:** Yes (analyzed below)');
  }

  lines.push('');

  for (const [i, d] of diagnoses.entries()) {
    const icon = d.severity === 'error' ? 'ERROR' : d.severity === 'warning' ? 'WARNING' : 'INFO';
    lines.push(`---`);
    lines.push(`## ${i + 1}. [${icon}] ${d.diagnosis}`);
    lines.push('');
    for (const step of d.steps) {
      lines.push(`- ${step}`);
    }
    if (d.references && d.references.length > 0) {
      lines.push('');
      lines.push('**References:**');
      for (const ref of d.references) {
        lines.push(`- ${ref}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('## Still stuck?');
  lines.push('');
  lines.push('- Use `onesub_check_status` to verify server-side subscription state.');
  lines.push('- Use `onesub_setup` to regenerate the integration code and compare with your current implementation.');
  lines.push('- Open an issue at https://github.com/onesub/onesub with your logs.');

  return lines.join('\n');
}
