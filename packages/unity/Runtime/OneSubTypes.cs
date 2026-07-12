using System;

namespace OneSub.Unity
{
    public enum OneSubProductType
    {
        Consumable,
        NonConsumable,
        Subscription
    }

    [Serializable]
    public sealed class OneSubProductDefinition
    {
        public string id;
        public OneSubProductType type;

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
        public bool valid;
        public OneSubSubscription subscription;
        public OneSubPurchase purchase;
        public string action;
        public string error;
        public string errorCode;

        public bool IsEntitled => valid &&
            (subscription == null || subscription.status == "active" || subscription.status == "grace_period");
    }
}
