# API contract for the chat UI

Base URL: same origin as the frontend. All responses are JSON. The browser must send cookies (`credentials: "include"`). The server owns the session; the UI does not send a session ID or conversation history.

## `GET /api/session`

Creates or resumes a session and returns:

```json
{ "csrfToken": "opaque-token", "cart": { "items": [], "totalMinor": 0, "cartUrl": "https://demo.example/cart" } }
```

Call once when the chat opens. Keep `csrfToken` in memory and send it in `X-CSRF-Token` for cart confirmation. The session cookie is HttpOnly and SameSite=Lax.

## `POST /api/chat`

Request: `{ "message": "Нужен автомат 160 А в Астане" }`.

Response:

```json
{
  "reply": "Нашёл товар…",
  "products": [],
  "alternatives": [],
  "proposal": null,
  "warnings": []
}
```

`products` contains complete product cards (`id`, `name`, `article`, `productUrl`, `price`, `stock`, `facts`, `source`). `alternatives` contains `{candidate, details, comparison}`. Each `comparison` row has `{field, requested, offered, verdict}` where verdict is `match`, `different`, or `unknown`. `proposal`, when present, contains `id`, `productId`, `productName`, `productArticle`, `quantity`, `city`, `unitPrice`, `totalAmount`, and `expiresAt`. Display those exact fields before enabling confirmation. A chat response never changes the cart.

## `GET /api/cart`

Returns `{ "items": [], "totalMinor": 0, "cartUrl": "https://demo.example/cart" }` for the current session.

## `POST /api/cart/confirm`

Request: `{ "proposalId": "..." }` with `X-CSRF-Token` from `/api/session`. The only UI action that should call this route is an explicit click on “Да, добавить в корзину”.

Response: `{ "cart": { "items": [], "totalMinor": 0, "cartUrl": "..." }, "alreadyConfirmed": false }`. On success, show `cart.cartUrl`. The server rechecks the selected city's stock and the price; a changed price or insufficient stock yields HTTP 409 and requires a new proposal.

## `POST /api/attachments`

Multipart form with one `file` (PDF, DOCX, XLSX, or JPEG; maximum 10 MB). Returns `{ "items": [{ "source_row": 2, "article": "200300285_", "name": "Автомат", "quantity": 1, "unit": "шт", "uncertainty": "none" }], "uncertainties": [] }`. Insert the extracted articles/names into the chat composer for customer review. Extraction never changes the cart.

## Errors

`{ "error": { "code": "...", "message": "..." } }`. Invalid input is 400, missing proposal 404, stale price or stock 409, upstream catalog/model failures 502. Do not show raw internal errors or API credentials in the UI.
