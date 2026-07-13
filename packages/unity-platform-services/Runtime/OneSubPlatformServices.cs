using System;
using System.Collections;
using System.IO;
using UnityEngine;
using UnityEngine.SocialPlatforms;
using UnityNative.Sharing;

namespace OneSub.Unity
{
    public sealed class OneSubPlatformServices : MonoBehaviour
    {
        private static OneSubPlatformServices instance;

        public static OneSubPlatformServices Instance
        {
            get
            {
                if (instance != null) return instance;
                var gameObject = new GameObject("OneSubPlatformServices");
                instance = gameObject.AddComponent<OneSubPlatformServices>();
                DontDestroyOnLoad(gameObject);
                return instance;
            }
        }

        public bool IsAuthenticated => Social.localUser.authenticated;

        public void Authenticate(Action<bool> completed)
        {
            if (IsAuthenticated)
            {
                completed?.Invoke(true);
                return;
            }
            Social.localUser.Authenticate(completed);
        }

        public void ReportScore(string leaderboardId, long score, Action<bool> completed = null)
        {
            Social.ReportScore(score, leaderboardId, completed);
        }

        public void ReportAchievement(string achievementId, double progress, Action<bool> completed = null)
        {
            Social.ReportProgress(achievementId, progress, completed);
        }

        public void ShowLeaderboards() => Social.ShowLeaderboardUI();
        public void ShowAchievements() => Social.ShowAchievementsUI();

        public void ShareText(string text)
        {
            UnityNativeSharing.Create().ShareText(text ?? string.Empty);
        }

        public void ShareScreenshot(string text, string url, Action completed = null, Action<string> failed = null)
        {
            StartCoroutine(CaptureAndShare(text, url, completed, failed));
        }

        public void RequestReview(string storeUrl = null)
        {
#if UNITY_IOS && !UNITY_EDITOR
            UnityEngine.iOS.Device.RequestStoreReview();
#elif UNITY_ANDROID && !UNITY_EDITOR
            RequestGooglePlayReview(storeUrl);
#else
            if (!string.IsNullOrWhiteSpace(storeUrl)) Application.OpenURL(storeUrl);
#endif
        }

#if UNITY_ANDROID && !UNITY_EDITOR
        private void RequestGooglePlayReview(string fallbackUrl)
        {
            try
            {
                using var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
                var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
                using var factory = new AndroidJavaClass("com.google.android.play.core.review.ReviewManagerFactory");
                var manager = factory.CallStatic<AndroidJavaObject>("create", activity);
                var requestTask = manager.Call<AndroidJavaObject>("requestReviewFlow");
                requestTask.Call<AndroidJavaObject>("addOnCompleteListener",
                    new ReviewTaskListener(task =>
                    {
                        if (!task.Call<bool>("isSuccessful"))
                        {
                            if (!string.IsNullOrWhiteSpace(fallbackUrl)) Application.OpenURL(fallbackUrl);
                            return;
                        }
                        var reviewInfo = task.Call<AndroidJavaObject>("getResult");
                        var launchTask = manager.Call<AndroidJavaObject>("launchReviewFlow", activity, reviewInfo);
                        launchTask.Call<AndroidJavaObject>("addOnCompleteListener",
                            new ReviewTaskListener(_ => { }));
                    }));
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"[onesub] In-app review unavailable: {exception.Message}");
                if (!string.IsNullOrWhiteSpace(fallbackUrl)) Application.OpenURL(fallbackUrl);
            }
        }

        private sealed class ReviewTaskListener : AndroidJavaProxy
        {
            private readonly Action<AndroidJavaObject> completed;

            public ReviewTaskListener(Action<AndroidJavaObject> completed)
                : base("com.google.android.gms.tasks.OnCompleteListener")
            {
                this.completed = completed;
            }

            public void onComplete(AndroidJavaObject task) => completed?.Invoke(task);
        }
#endif

        private static IEnumerator CaptureAndShare(string text, string url, Action completed, Action<string> failed)
        {
            yield return new WaitForEndOfFrame();
            var path = Path.Combine(Application.temporaryCachePath, "onesub-share.png");
            try
            {
                var texture = ScreenCapture.CaptureScreenshotAsTexture();
                File.WriteAllBytes(path, texture.EncodeToPNG());
                Destroy(texture);
                var body = string.IsNullOrWhiteSpace(url) ? text : $"{text}\n{url}";
                UnityNativeSharing.Create().ShareScreenshotAndText(body, path);
                completed?.Invoke();
            }
            catch (Exception exception)
            {
                failed?.Invoke(exception.Message);
            }
        }
    }
}
