using NUnit.Framework;
using UnityEditor;
using UnityEngine;

namespace OneSub.Unity.Tests
{
    public sealed class OneSubSettingsTests
    {
        [Test]
        public void ValidSettingsPassValidation()
        {
            var settings = CreateSettings(
                "https://billing.example.com/",
                new OneSubProductDefinition("pro_monthly", OneSubProductType.Subscription));

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.True, error);
                Assert.That(settings.ServerUrl, Is.EqualTo("https://billing.example.com"));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [Test]
        public void SettingsRequireAtLeastOneProduct()
        {
            var settings = CreateSettings("https://billing.example.com");

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.False);
                Assert.That(error, Does.Contain("At least one"));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [Test]
        public void SettingsRejectDuplicateProductIds()
        {
            var settings = CreateSettings(
                "https://billing.example.com",
                new OneSubProductDefinition("coins", OneSubProductType.Consumable),
                new OneSubProductDefinition("coins", OneSubProductType.NonConsumable));

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.False);
                Assert.That(error, Does.Contain("Duplicate"));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [TestCase("")]
        [TestCase("billing.example.com")]
        [TestCase("ftp://billing.example.com")]
        public void SettingsRequireAbsoluteHttpServerUrl(string serverUrl)
        {
            var settings = CreateSettings(
                serverUrl,
                new OneSubProductDefinition("pro", OneSubProductType.Subscription));

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.False);
                Assert.That(error, Does.Contain("HTTP or HTTPS"));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [TestCase("https://user:password@billing.example.com", "credentials")]
        [TestCase("https://billing.example.com?tenant=one", "query string")]
        [TestCase("https://billing.example.com#production", "fragment")]
        public void SettingsRejectUnsafeBaseUrlShapes(string serverUrl, string expectedMessage)
        {
            var settings = CreateSettings(
                serverUrl,
                new OneSubProductDefinition("pro", OneSubProductType.Subscription));

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.False);
                Assert.That(error, Does.Contain(expectedMessage));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [TestCase(" pro")]
        [TestCase("pro ")]
        public void SettingsRejectProductIdWhitespace(string productId)
        {
            var settings = CreateSettings(
                "https://billing.example.com",
                new OneSubProductDefinition(productId, OneSubProductType.Subscription));

            try
            {
                Assert.That(settings.TryValidate(out var error), Is.False);
                Assert.That(error, Does.Contain("whitespace"));
            }
            finally
            {
                Object.DestroyImmediate(settings);
            }
        }

        [Test]
        public void LowLevelConfigurationUsesTheSameValidationRules()
        {
            var products = new[]
            {
                new OneSubProductDefinition("pro", (OneSubProductType)999)
            };

            Assert.That(
                OneSubSettings.TryValidateConfiguration(
                    "https://billing.example.com",
                    products,
                    out var error),
                Is.False);
            Assert.That(error, Does.Contain("invalid product type"));
        }

        private static OneSubSettings CreateSettings(
            string serverUrl,
            params OneSubProductDefinition[] products)
        {
            var settings = ScriptableObject.CreateInstance<OneSubSettings>();
            var serialized = new SerializedObject(settings);
            serialized.FindProperty("serverUrl").stringValue = serverUrl;

            var productList = serialized.FindProperty("products");
            productList.arraySize = products.Length;
            for (var index = 0; index < products.Length; index++)
            {
                var element = productList.GetArrayElementAtIndex(index);
                element.FindPropertyRelative("id").stringValue = products[index].id;
                element.FindPropertyRelative("type").enumValueIndex = (int)products[index].type;
            }

            serialized.ApplyModifiedPropertiesWithoutUndo();
            return settings;
        }
    }
}
