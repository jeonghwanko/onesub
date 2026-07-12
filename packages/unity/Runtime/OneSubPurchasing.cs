using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using UnityEngine.Purchasing;

namespace OneSub.Unity
{
    public sealed class OneSubPurchasing : MonoBehaviour
    {
        private static OneSubPurchasing instance;
        private readonly Dictionary<string, OneSubProductType> productTypes = new();
        private readonly HashSet<string> validationsInFlight = new();
        private readonly HashSet<string> userInitiated = new();
        private StoreController storeController;
        private OneSubClient client;

        public static OneSubPurchasing Instance
        {
            get
            {
                if (instance != null) return instance;
                var gameObject = new GameObject("OneSubPurchasing");
                instance = gameObject.AddComponent<OneSubPurchasing>();
                DontDestroyOnLoad(gameObject);
                return instance;
            }
        }

        public static OneSubPurchasing ExistingInstance => instance;

        public Func<string> UserIdProvider { get; set; }
        public bool IsInitialized { get; private set; }
        public event Action<bool> Initialized;
        public event Action<string, OneSubValidationResult> PurchaseSucceeded;

        /// <summary>Raised only for a purchase the player actually started. Safe to surface in UI.</summary>
        public event Action<string, string> PurchaseFailed;

        /// <summary>
        /// Raised when a background check (launch-time fetch, restore, pending-order replay) fails.
        /// The player did not ask for this, so it must not be shown as a failed purchase.
        /// </summary>
        public event Action<string, string> ValidationFailed;

        public event Action<string, OneSubEntitlementState> SubscriptionChanged;

        public async void Initialize(
            IEnumerable<OneSubProductDefinition> products,
            string serverUrl,
            Func<string> userIdProvider)
        {
            UserIdProvider = userIdProvider;
            client = new OneSubClient(serverUrl);
            productTypes.Clear();
            foreach (var definition in products ?? Array.Empty<OneSubProductDefinition>())
            {
                if (!string.IsNullOrWhiteSpace(definition?.id))
                    productTypes[definition.id] = definition.type;
            }

            DetachStoreEvents();
            storeController = UnityIAPServices.StoreController();
            AttachStoreEvents();
            storeController.ProcessPendingOrdersOnPurchasesFetched(true);

            try
            {
                await storeController.Connect();
            }
            catch (Exception exception)
            {
                FailInitialization(exception.Message);
            }
        }

        public void Buy(string productId)
        {
            userInitiated.Add(productId);

            if (!IsInitialized || storeController == null)
            {
                FailPurchase(productId, "The store is not initialized.");
                return;
            }
            if (GetProduct(productId) == null)
            {
                FailPurchase(productId, $"Product '{productId}' was not returned by the store.");
                return;
            }
            if (string.IsNullOrWhiteSpace(UserIdProvider?.Invoke()))
            {
                FailPurchase(productId, "Sign in before purchasing so onesub can bind the receipt to an account.");
                return;
            }
            storeController.PurchaseProduct(productId);
        }

        public void RestorePurchases()
        {
            if (storeController == null)
            {
                ValidationFailed?.Invoke(string.Empty, "The store is not initialized.");
                return;
            }
            storeController.FetchPurchases();
        }

        /// <summary>
        /// Reports a failure to the player only if they started this purchase; otherwise it is
        /// background noise (a launch-time revalidation, a restore) and goes to ValidationFailed.
        /// </summary>
        private void FailPurchase(string productId, string message)
        {
            if (userInitiated.Remove(productId))
                PurchaseFailed?.Invoke(productId, message);
            else
                ValidationFailed?.Invoke(productId, message);
        }

        public Product GetProduct(string productId)
        {
            return storeController?.GetProducts().FirstOrDefault(product =>
                string.Equals(product.definition.id, productId, StringComparison.Ordinal));
        }

        public string GetLocalizedPrice(string productId)
        {
            return GetProduct(productId)?.metadata?.localizedPriceString;
        }

        private void OnStoreConnected()
        {
            var products = productTypes.Select(pair =>
                new ProductDefinition(pair.Key, ToUnityType(pair.Value))).ToList();
            storeController.FetchProducts(products);
        }

        private void OnProductsFetched(List<Product> products)
        {
            IsInitialized = true;
            Initialized?.Invoke(true);
            storeController.FetchPurchases();
        }

        private void OnProductsFetchFailed(ProductFetchFailed failure)
        {
            FailInitialization(failure.FailureReason.ToString());
        }

        private void OnStoreDisconnected(StoreConnectionFailureDescription failure)
        {
            if (!IsInitialized) FailInitialization(failure.message);
        }

        private void OnPurchasePending(PendingOrder order)
        {
            ValidateOrder(order, true);
        }

        private void OnPurchasesFetched(Orders orders)
        {
            var ownedSubscriptions = new HashSet<string>();

            foreach (var order in orders?.ConfirmedOrders ?? Array.Empty<ConfirmedOrder>())
            {
                var productId = ProductId(order);
                if (!productTypes.TryGetValue(productId, out var type) || type == OneSubProductType.Consumable)
                    continue;

                if (type == OneSubProductType.Subscription)
                    ownedSubscriptions.Add(productId);

                ValidateOrder(order, false);
            }

            // A subscription can also be sitting in a pending or deferred order (just bought and not
            // yet acknowledged, or awaiting parental approval). It is still owned, so it must not be
            // treated as gone below -- the pending-order replay validates it a moment later.
            MarkSubscriptionsOwned(orders?.PendingOrders, ownedSubscriptions);
            MarkSubscriptionsOwned(orders?.DeferredOrders, ownedSubscriptions);

            // The store answered and did not list this subscription at all, so it is genuinely gone
            // (cancelled or expired). This is the only signal that may clear a cached entitlement --
            // without it a lapsed subscriber would keep their benefits forever.
            foreach (var pair in productTypes)
            {
                if (pair.Value == OneSubProductType.Subscription && !ownedSubscriptions.Contains(pair.Key))
                    SubscriptionChanged?.Invoke(pair.Key, OneSubEntitlementState.NotEntitled);
            }
        }

        private void MarkSubscriptionsOwned<T>(IReadOnlyList<T> orders, HashSet<string> owned) where T : Order
        {
            foreach (var order in orders ?? (IReadOnlyList<T>)Array.Empty<T>())
            {
                var productId = ProductId(order);
                if (productTypes.TryGetValue(productId, out var type) && type == OneSubProductType.Subscription)
                    owned.Add(productId);
            }
        }

        private void OnPurchasesFetchFailed(PurchasesFetchFailureDescription failure)
        {
            // We never heard from the store, so we know nothing about entitlements. Stay silent and
            // leave every cached entitlement standing.
            ValidationFailed?.Invoke(string.Empty, failure.Message);
        }

        private void OnPurchaseFailed(FailedOrder order)
        {
            FailPurchase(ProductId(order), $"{order.FailureReason}: {order.Details}");
        }

        private void OnPurchaseDeferred(DeferredOrder order)
        {
            FailPurchase(ProductId(order), "Purchase is pending store or parental approval.");
        }

        private void ValidateOrder(Order order, bool confirmAfterValidation)
        {
            var productId = ProductId(order);
            if (!productTypes.TryGetValue(productId, out var type))
            {
                FailPurchase(productId, "The order contains an unknown product.");
                return;
            }

            var receipt = ReceiptToken(order);
            var key = string.IsNullOrWhiteSpace(order.Info.TransactionID)
                ? $"{productId}:{receipt}"
                : order.Info.TransactionID;
            if (!validationsInFlight.Add(key)) return;
            StartCoroutine(ValidateOrderCoroutine(order, type, receipt, key, confirmAfterValidation));
        }

        private IEnumerator ValidateOrderCoroutine(
            Order order,
            OneSubProductType type,
            string receipt,
            string validationKey,
            bool confirmAfterValidation)
        {
            OneSubValidationResult result = null;
            yield return client.Validate(
                receipt,
                UserIdProvider?.Invoke(),
                ProductId(order),
                type,
                value => result = value);
            validationsInFlight.Remove(validationKey);

            var productId = ProductId(order);
            if (type == OneSubProductType.Subscription)
            {
                // Unknown when onesub never answered -- the listener keeps its cached entitlement
                // rather than pulling a paid subscription out from under an offline player.
                SubscriptionChanged?.Invoke(
                    productId, result?.Entitlement ?? OneSubEntitlementState.Unknown);
            }

            if (result == null || !result.IsEntitled)
            {
                FailPurchase(productId, result?.error ?? "onesub rejected the receipt.");
                yield break;
            }

            if (confirmAfterValidation && order is PendingOrder pendingOrder)
            {
                userInitiated.Remove(productId);
                PurchaseSucceeded?.Invoke(productId, result);
                storeController.ConfirmPurchase(pendingOrder);
            }
        }

        private static string ProductId(Order order)
        {
            return order?.CartOrdered?.Items().FirstOrDefault()?.Product?.definition?.id ?? string.Empty;
        }

        private static string ReceiptToken(Order order)
        {
#if UNITY_IOS && !UNITY_EDITOR
            return order?.Info?.Apple?.jwsRepresentation ?? string.Empty;
#else
            // Unity IAP uses the Google purchase token as TransactionID.
            return order?.Info?.TransactionID ?? string.Empty;
#endif
        }

        private static ProductType ToUnityType(OneSubProductType type)
        {
            return type switch
            {
                OneSubProductType.Consumable => ProductType.Consumable,
                OneSubProductType.NonConsumable => ProductType.NonConsumable,
                _ => ProductType.Subscription
            };
        }

        private void FailInitialization(string message)
        {
            IsInitialized = false;
            Debug.LogError($"[onesub] Store initialization failed: {message}");
            Initialized?.Invoke(false);
        }

        private void AttachStoreEvents()
        {
            storeController.OnStoreConnected += OnStoreConnected;
            storeController.OnStoreDisconnected += OnStoreDisconnected;
            storeController.OnProductsFetched += OnProductsFetched;
            storeController.OnProductsFetchFailed += OnProductsFetchFailed;
            storeController.OnPurchasesFetched += OnPurchasesFetched;
            storeController.OnPurchasesFetchFailed += OnPurchasesFetchFailed;
            storeController.OnPurchasePending += OnPurchasePending;
            storeController.OnPurchaseFailed += OnPurchaseFailed;
            storeController.OnPurchaseDeferred += OnPurchaseDeferred;
        }

        private void DetachStoreEvents()
        {
            if (storeController == null) return;
            storeController.OnStoreConnected -= OnStoreConnected;
            storeController.OnStoreDisconnected -= OnStoreDisconnected;
            storeController.OnProductsFetched -= OnProductsFetched;
            storeController.OnProductsFetchFailed -= OnProductsFetchFailed;
            storeController.OnPurchasesFetched -= OnPurchasesFetched;
            storeController.OnPurchasesFetchFailed -= OnPurchasesFetchFailed;
            storeController.OnPurchasePending -= OnPurchasePending;
            storeController.OnPurchaseFailed -= OnPurchaseFailed;
            storeController.OnPurchaseDeferred -= OnPurchaseDeferred;
        }

        private void OnDestroy()
        {
            DetachStoreEvents();
            if (instance == this) instance = null;
        }
    }
}
