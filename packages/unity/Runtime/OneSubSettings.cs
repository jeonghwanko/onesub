using System;
using System.Collections.Generic;
using UnityEngine;

namespace OneSub.Unity
{
    public interface IOneSubUserIdProvider
    {
        string GetUserId();
    }

    [CreateAssetMenu(fileName = "OneSubSettings", menuName = "OneSub/Settings")]
    public sealed class OneSubSettings : ScriptableObject
    {
        private static readonly OneSubProductDefinition[] EmptyProducts =
            Array.Empty<OneSubProductDefinition>();

        [Tooltip("Base URL of the self-hosted OneSub server.")]
        [SerializeField] private string serverUrl = "http://localhost:4100";

        [Tooltip("Store product IDs and their Unity IAP product types.")]
        [SerializeField] private List<OneSubProductDefinition> products = new();

        public string ServerUrl => NormalizeServerUrl(serverUrl);
        public IReadOnlyList<OneSubProductDefinition> Products =>
            products != null ? (IReadOnlyList<OneSubProductDefinition>)products : EmptyProducts;

        public bool TryValidate(out string error)
        {
            return TryValidateConfiguration(ServerUrl, Products, out error);
        }

        public static bool TryValidateConfiguration(
            string serverUrl,
            IReadOnlyList<OneSubProductDefinition> products,
            out string error)
        {
            var normalizedServerUrl = NormalizeServerUrl(serverUrl);
            if (!Uri.TryCreate(normalizedServerUrl, UriKind.Absolute, out var uri)
                || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
            {
                error = "OneSub server URL must be an absolute HTTP or HTTPS URL.";
                return false;
            }

            if (!string.IsNullOrEmpty(uri.UserInfo))
            {
                error = "OneSub server URL must not contain credentials.";
                return false;
            }

            if (!string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment))
            {
                error = "OneSub server URL must not contain a query string or fragment.";
                return false;
            }

            if (products == null || products.Count == 0)
            {
                error = "At least one OneSub product is required.";
                return false;
            }

            var productIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var product in products)
            {
                if (product == null || string.IsNullOrWhiteSpace(product.id))
                {
                    error = "Every OneSub product requires a non-empty product ID.";
                    return false;
                }

                if (!string.Equals(product.id, product.id.Trim(), StringComparison.Ordinal))
                {
                    error = $"OneSub product ID must not have leading or trailing whitespace: '{product.id}'";
                    return false;
                }

                if (!Enum.IsDefined(typeof(OneSubProductType), product.type))
                {
                    error = $"OneSub product '{product.id}' has an invalid product type.";
                    return false;
                }

                if (!productIds.Add(product.id))
                {
                    error = $"Duplicate OneSub product ID: {product.id}";
                    return false;
                }
            }

            error = string.Empty;
            return true;
        }

        internal static string NormalizeServerUrl(string value)
        {
            return (value ?? string.Empty).Trim().TrimEnd('/');
        }
    }
}
