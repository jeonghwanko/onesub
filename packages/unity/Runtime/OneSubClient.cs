using System;
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

namespace OneSub.Unity
{
    public sealed class OneSubClient
    {
        [Serializable]
        private sealed class ValidationRequest
        {
            public string platform;
            public string receipt;
            public string userId;
            public string productId;
            public string type;
            /// <summary>
            /// Which app this receipt belongs to, so one onesub server can serve several.
            /// An Apple receipt names its own bundle, but a Google purchase token does not —
            /// without this the server would fall back to its default app.
            /// </summary>
            public string appId;
        }

        public string ServerUrl { get; set; }
        public int TimeoutSeconds { get; set; } = 15;

        public OneSubClient(string serverUrl)
        {
            ServerUrl = OneSubSettings.NormalizeServerUrl(serverUrl);
        }

        public IEnumerator Validate(
            string receipt,
            string userId,
            string productId,
            OneSubProductType productType,
            Action<OneSubValidationResult> completed)
        {
            if (string.IsNullOrWhiteSpace(ServerUrl))
            {
                completed?.Invoke(Failure(
                    OneSubValidationResult.ERROR_NOT_CONFIGURED, "onesub server URL is empty."));
                yield break;
            }

            if (string.IsNullOrWhiteSpace(userId))
            {
                completed?.Invoke(Failure(
                    OneSubValidationResult.ERROR_USER_ID_REQUIRED, "A stable signed-in user ID is required."));
                yield break;
            }

            if (string.IsNullOrWhiteSpace(receipt))
            {
                completed?.Invoke(Failure(
                    OneSubValidationResult.ERROR_NO_RECEIPT_DATA, "The store returned no receipt or purchase token."));
                yield break;
            }

            var request = new ValidationRequest
            {
                platform = PlatformName,
                receipt = receipt,
                userId = userId,
                productId = productId,
                type = ApiType(productType),
                appId = Application.identifier
            };
            var path = productType == OneSubProductType.Subscription
                ? "/onesub/validate"
                : "/onesub/purchase/validate";
            var json = JsonUtility.ToJson(request);

            using var webRequest = new UnityWebRequest(ServerUrl + path, UnityWebRequest.kHttpVerbPOST);
            webRequest.uploadHandler = new UploadHandlerRaw(System.Text.Encoding.UTF8.GetBytes(json));
            webRequest.downloadHandler = new DownloadHandlerBuffer();
            webRequest.timeout = TimeoutSeconds;
            webRequest.SetRequestHeader("Content-Type", "application/json");

            yield return webRequest.SendWebRequest();

            if (webRequest.result != UnityWebRequest.Result.Success)
            {
                var body = webRequest.downloadHandler.text;
                // Only a rejection aimed at the receipt itself is a verdict. Timeouts, 5xx, throttling
                // and auth problems are our fault, not the player's, and must stay non-authoritative
                // so a live subscription is never revoked because the server was unreachable.
                var serverFailure = IsReceiptVerdict(webRequest.responseCode) ? Parse(body) : null;
                completed?.Invoke(serverFailure ?? Failure(
                    OneSubValidationResult.ERROR_NETWORK,
                    string.IsNullOrWhiteSpace(body) ? webRequest.error : body));
                yield break;
            }

            completed?.Invoke(Parse(webRequest.downloadHandler.text) ?? Failure(
                OneSubValidationResult.ERROR_INVALID_RESPONSE,
                "onesub returned an invalid or empty response."));
        }

        private static bool IsReceiptVerdict(long statusCode)
        {
            if (statusCode < 400 || statusCode >= 500) return false;

            // 401/403 (credentials), 408 (timeout) and 429 (throttled) say nothing about the receipt.
            return statusCode != 401 && statusCode != 403 && statusCode != 408 && statusCode != 429;
        }

        private static string PlatformName
        {
            get
            {
#if UNITY_IOS
                return "apple";
#else
                return "google";
#endif
            }
        }

        private static string ApiType(OneSubProductType type)
        {
            return type switch
            {
                OneSubProductType.Consumable => "consumable",
                OneSubProductType.NonConsumable => "non_consumable",
                _ => "subscription"
            };
        }

        private static OneSubValidationResult Failure(string code, string message)
        {
            return new OneSubValidationResult { valid = false, errorCode = code, error = message };
        }

        private static OneSubValidationResult Parse(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return null;
            try
            {
                return JsonUtility.FromJson<OneSubValidationResult>(json);
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
