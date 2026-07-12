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
    }
}
