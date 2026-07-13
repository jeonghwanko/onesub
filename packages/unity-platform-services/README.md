# OneSub Unity Platform Services

Optional platform helpers extracted from PenguinRun. This package provides
`OneSubPlatformServices` for native sharing, in-app review, Unity Social authentication,
leaderboards, and achievements.

It is not part of the OneSub purchasing Core. Most OneSub users should integrate their existing
platform-service stack instead.

## Requirements

- `com.onesub.unity` 0.2.x
- Unity Native Sharing 1.x, installed as a direct project dependency
- External Dependency Manager for Unity when Android in-app review is required

Unity Native Sharing is a Git package and cannot be resolved from Unity's default registry. Pin it
in the host project's `Packages/manifest.json` before adding this package:

```json
{
  "dependencies": {
    "com.unitynative.sharing": "https://github.com/NicholasSheehan/Unity-Native-Sharing.git#688fa653cc68ed24fbc3ec926b127c2dfa4c8b96"
  }
}
```

The runtime assembly is disabled when Unity Native Sharing is absent. The Google Play Review Maven
declaration is contained only in this optional package, so installing OneSub Core alone does not add
review dependencies.
