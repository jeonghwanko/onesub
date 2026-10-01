---
"@onesub/providers": minor
---

Google `createOneTimePurchase` refuses a product ID that already exists (`errorType: 'DUPLICATE'`) instead of silently replacing its listings and regional prices through the PATCH upsert. Play API errors now carry `httpStatus`.
