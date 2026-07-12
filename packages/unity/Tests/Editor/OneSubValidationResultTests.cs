using NUnit.Framework;

namespace OneSub.Unity.Tests
{
    public class OneSubValidationResultTests
    {
        [TestCase("active", true)]
        [TestCase("grace_period", true)]
        [TestCase("expired", false)]
        [TestCase("canceled", false)]
        [TestCase("on_hold", false)]
        [TestCase("paused", false)]
        public void SubscriptionEntitlementMatchesServerLifecycle(string status, bool expected)
        {
            var result = new OneSubValidationResult
            {
                valid = true,
                subscription = new OneSubSubscription { status = status }
            };

            Assert.That(result.IsEntitled, Is.EqualTo(expected));
        }

        [Test]
        public void InvalidOneTimePurchaseIsNotEntitled()
        {
            var result = new OneSubValidationResult
            {
                valid = false,
                purchase = new OneSubPurchase()
            };

            Assert.That(result.IsEntitled, Is.False);
        }

        [TestCase(OneSubValidationResult.ERROR_NETWORK)]
        [TestCase(OneSubValidationResult.ERROR_NOT_CONFIGURED)]
        [TestCase(OneSubValidationResult.ERROR_USER_ID_REQUIRED)]
        [TestCase(OneSubValidationResult.ERROR_NO_RECEIPT_DATA)]
        [TestCase(OneSubValidationResult.ERROR_INVALID_RESPONSE)]
        public void ClientSideFailureIsUnknownRatherThanUnentitled(string errorCode)
        {
            var result = new OneSubValidationResult { valid = false, errorCode = errorCode };

            // The server never answered, so revoking the subscription here would strip a paying
            // player of their benefits just because they were offline.
            Assert.That(result.IsAuthoritative, Is.False);
            Assert.That(result.Entitlement, Is.EqualTo(OneSubEntitlementState.Unknown));
        }

        [Test]
        public void ServerRejectionIsAuthoritativeAndRevokes()
        {
            var result = new OneSubValidationResult { valid = false, errorCode = "INVALID_RECEIPT" };

            Assert.That(result.IsAuthoritative, Is.True);
            Assert.That(result.Entitlement, Is.EqualTo(OneSubEntitlementState.NotEntitled));
        }

        [Test]
        public void ExpiredSubscriptionIsAuthoritativeAndRevokes()
        {
            var result = new OneSubValidationResult
            {
                valid = true,
                subscription = new OneSubSubscription { status = "expired" }
            };

            Assert.That(result.Entitlement, Is.EqualTo(OneSubEntitlementState.NotEntitled));
        }

        [Test]
        public void ActiveSubscriptionIsEntitled()
        {
            var result = new OneSubValidationResult
            {
                valid = true,
                subscription = new OneSubSubscription { status = "active" }
            };

            Assert.That(result.Entitlement, Is.EqualTo(OneSubEntitlementState.Entitled));
        }
    }
}
