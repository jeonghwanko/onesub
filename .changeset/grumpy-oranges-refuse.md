---
"@onesub/mcp-server": patch
"@jeonghwanko/onesub-sdk": minor
"@onesub/shared": patch
"@onesub/providers": patch
"@onesub/server": patch
"@onesub/cli": patch
---

Tighten MCP provider compatibility. For the SDK, remove the unused Expo peer,
compile against the real react-native-iap declarations in an isolated peer
matrix, stop materializing host-owned React Native tooling during repository
installs, and state the tested v15 peer range explicitly because v16 has a
different requestPurchase contract. Keep test-only sources and compiled tests
out of every published npm package archive, and add a release-artifact gate so
test files, credential-like files, or missing declared entry points fail CI.
