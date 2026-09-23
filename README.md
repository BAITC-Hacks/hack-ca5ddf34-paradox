# EKT AI Assistant backend

Backend vertical slice for the HackAlem AI trade-track case from Электрокомплект (ekt.kz).

The design separates factual catalog access, the LLM orchestration loop, and cart mutation. This lets the demo be fast while keeping the dangerous operation — adding an item to a cart — behind a second explicit confirmation request.

## Architecture

```text
HTTP adapter (to be added)
  ├─ POST /chat  ───────────────┐
  ├─ GET  /cart                  │ session cookie / server-side session
  └─ POST /cart/confirm          │
                                 ▼
EktAssistantRuntime
  ├─ AssistantRunner (Responses API + strict function tools)
  │    ├─ search_products
  │    ├─ get_product_details
  │    ├─ find_alternatives
  │    ├─ get_purchase_terms
  │    └─ prepare_cart_item  ──► pending proposal only
  ├─ EktCatalogReader ──────────► EktClient ──────────► ekt.kz API
  └─ DemoCartProvider ──────────► confirm() only after explicit “Да, добавить”
```

The two-person split for the hackathon is:

1. Backend/AI: API adapter, `EktAssistantRuntime`, tool prompts, sources and safety tests.
2. Frontend/demo: chat UI, attachment upload, proposal confirmation button, cart/checkout link and 3-minute presentation flow.

### Safety contract

- Prices and stock are read from the catalog before the assistant makes a claim.
- City aliases such as `Нур-Султан` are normalized to `Астана`; service warehouses are not treated as customer stock.
- Conflicting claims, such as a current rating in the name versus a specification, are returned with both sources instead of being silently resolved.
- Alternatives are candidates requiring compatibility verification, never guaranteed substitutes.
- `prepare_cart_item` does not mutate the cart. The UI must show product, article, quantity, city, unit price and total, then call `cart.confirm` only for the exact pending proposal.
- The demo cart is session-scoped, rechecks price and stock during confirmation, is idempotent on repeated confirmation, and never puts a session ID in the cart URL.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

The EKT credentials are read only from environment variables and must never be committed.

## Composition root

`EktAssistantRuntime` wires the catalog, sourced purchase terms, Responses function-calling loop and session-bound cart:

```ts
const app = new EktAssistantRuntime({ appBaseUrl: "http://localhost:3000" });
const answer = await app.run({
  sessionId: request.session.id,
  message: "Нужен автомат 160 А в Астане",
  history: [],
});

// After the customer explicitly confirms the exact proposal:
const result = await app.cart.confirm({
  sessionId: request.session.id,
  proposalId,
  confirmed: true,
});
```

`DemoCartProvider` is intentionally process-local for the hackathon demo. Before production, replace it with Redis/DB-backed storage and keep the same `CartProvider` contract.

## Demo promise

The assistant reads current product data before answering price or availability questions. It creates a cart change as a pending proposal and mutates the cart only after an explicit customer confirmation.
