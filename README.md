# EKT AI Assistant backend

Backend prototype for the HackAlem AI trade track case from Электрокомплект (ekt.kz).

The first vertical slice covers:

- catalog lookup by SKU, article, or product name;
- product details, characteristics, certificates, and city-aware stock;
- explainable alternatives;
- purchase terms;
- a session-scoped cart with explicit confirmation and stock checks.

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

The EKT credentials are read only from environment variables and must never be committed.

## Demo promise

The assistant reads current product data before answering price or availability questions. It creates a cart change as a pending proposal and mutates the cart only after an explicit customer confirmation.
