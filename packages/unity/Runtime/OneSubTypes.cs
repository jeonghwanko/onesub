using System;

namespace OneSub.Unity
{
    public enum OneSubProductType
    {
        Consumable,
        NonConsumable,
        Subscription
    }

    /// <summary>
    /// Outcome of an entitlement check. <see cref="Unknown"/> means onesub never answered, so the
    /// caller must keep whatever entitlement it had cached instead of revoking a paid subscription.
    /// </summary>
    public enum OneSubEntitlementState
    {
        Unknown,
        Entitled,
        NotEntitled
    }

    [Serializable]
    public sealed class OneSubProductDefinition
    {
        public string id;
        public OneSubProductType type;

        public OneSubProductDefinition()
        {
        }

        public OneSubProductDefinition(string id, OneSubProductType type)
        {
            this.id = id;
            this.type = type;
        }
    }

    [Serializable]
    public sealed class OneSubSubscription
    {
        public string userId;
        public string productId;
        public string platform;
        public string status;
        public string expiresAt;
        public string originalTransactionId;
        public string purchasedAt;
        public bool willRenew;
    }

    [Serializable]
    public sealed class OneSubPurchase
    {
        public string userId;
        public string productId;
        public string platform;
        public string type;
        public string transactionId;
        public string purchasedAt;
        public int quantity;
    }

    [Serializable]
    public sealed class OneSubValidationResult
    {
        // Codes raised by the client itself, before onesub ever saw the receipt.
        public const string ERROR_NOT_CONFIGURED = "ONESUB_NOT_CONFIGURED";
        public const string ERROR_USER_ID_REQUIRED = "USER_ID_REQUIRED";
        public const string ERROR_NO_RECEIPT_DATA = "NO_RECEIPT_DATA";
        public const string ERROR_NETWORK = "NETWORK_ERROR";
        public const string ERROR_INVALID_RESPONSE = "INVALID_SERVER_RESPONSE";

        public bool valid;
        public OneSubSubscription subscription;
        public OneSubPurchase purchase;
        public string action;
        public string error;
        public string errorCode;

        public bool IsEntitled => valid &&
            (subscription == null || subscription.status == "active" || subscription.status == "grace_period");

        /// <summary>
        /// True when onesub actually answered. A transport or configuration failure is not an
        /// answer, so it must never be read as "the user is not entitled".
        /// </summary>
        public bool IsAuthoritative => errorCode switch
        {
            ERROR_NOT_CONFIGURED or ERROR_USER_ID_REQUIRED or ERROR_NO_RECEIPT_DATA
                or ERROR_NETWORK or ERROR_INVALID_RESPONSE => false,
            _ => true
        };

        public OneSubEntitlementState Entitlement =>
            !IsAuthoritative ? OneSubEntitlementState.Unknown
            : IsEntitled ? OneSubEntitlementState.Entitled
            : OneSubEntitlementState.NotEntitled;
    }
}
