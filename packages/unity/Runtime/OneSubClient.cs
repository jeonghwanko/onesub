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
        }

        public string ServerUrl { get; set; }
        public int TimeoutSeconds { get; set; } = 15;

        public OneSubClient(string serverUrl)
        {
            ServerUrl = (serverUrl ?? string.Empty).TrimEnd('/');
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
                completed?.Invoke(Failure("ONESUB_NOT_CONFIGURED", "onesub server URL is empty."));
                yield break;
            }

            if (string.IsNullOrWhiteSpace(userId))
            {
                completed?.Invoke(Failure("USER_ID_REQUIRED", "A stable signed-in user ID is required."));
                yield break;
            }

            if (string.IsNullOrWhiteSpace(receipt))
            {
                completed?.Invoke(Failure("NO_RECEIPT_DATA", "The store returned no receipt or purchase token."));
                yield break;
            }

            var request = new ValidationRequest
            {
                platform = PlatformName,
                receipt = receipt,
                userId = userId,
                productId = productId,
                type = ApiType(productType)
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
                var serverFailure = Parse(body);
                completed?.Invoke(serverFailure ?? Failure(
                    "NETWORK_ERROR",
                    string.IsNullOrWhiteSpace(body) ? webRequest.error : body));
                yield break;
            }

            completed?.Invoke(Parse(webRequest.downloadHandler.text) ??
                Failure("INVALID_SERVER_RESPONSE", "onesub returned an invalid or empty response."));
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
