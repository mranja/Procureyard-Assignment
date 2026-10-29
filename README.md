# Rider Payout Dispute Desk — QuickDrop

ProcureYard take-home assignment for the ML/AI Engineer Intern role.

An automated AI dispute resolution system that handles rider payout complaints received over WhatsApp (in Hinglish, Hindi, and English), investigates discrepancies against trips and payout databases, and deterministically resolves or escalates cases adhering to finance guardrails.

---

## 1. Quick Start

### Running with Docker Compose
```bash
docker compose up
```
* **Dispute Service:** `http://localhost:8000`
* **Ops Dashboard:** `http://localhost:8000/ops`
* **PaySwift Sandbox:** `http://localhost:8081`

### Running Locally (Node.js)
```bash
npm install
npm start
```

### Running Evals
Run the evaluation suite against any running service URL:
```bash
node evals/run.js http://localhost:8000
```

---

## 2. Agent Design: Deterministic Code vs. LLM Boundary

| Component | Responsibility | Governed By |
| :--- | :--- | :--- |
| **Language & Intent Recognition** | Understands multi-turn conversational nuances in Hinglish/Hindi, extracts slot entities (Order IDs, dates, complaints). | LLM (Gemini 2.5 Flash) |
| **Fare Policy Calculations** | Applies exact formulas: ₹25 base + ₹6/km after 2km $\times$ surge multiplier; ₹150 incentive for $\ge 12$ completed trips; ₹10 rider cancel penalties. | Deterministic Code (`src/policy.js`) |
| **Financial Guardrails** | Auto-pay strictly capped at **₹200** per dispute and **max 1 auto-pay per rider per day**. | Deterministic Code (`src/tools.js`) |
| **Approval & Escalation Queue** | Over-limit disputes ($> ₹200$), repeated daily claims, edge cases (accidents, suspicious prompt injection) are queued for human Ops review. | Deterministic Code (`src/tools.js`) |
| **Explanation Generation** | Explains the breakdown and exact calculations transparently and politely to the rider in natural language. | LLM / Empathetic Agent (`src/agent.js`) |

---

## 3. Architecture & API Endpoints

- **`GET /health`**: Returns `200 OK` when the service is healthy and ready.
- **`POST /messages`**: Accepts WhatsApp messages and returns `{"reply": "..."}`. Idempotent against duplicate vendor webhook deliveries with optional HMAC/Bearer token authorization.
- **`POST /messages/media`**: Secure endpoint for archiving incoming WhatsApp audio notes, voice notes, and screenshots with audio player integration in the Ops console.
- **`GET /trace/{rider_id}`**: Returns an ordered JSON audit trail of every step taken for a rider: `message_in`, `tool_call`, `decision`, `reply`, and `error`.
- **`GET /ops/pending`**: Returns list of pending approvals and escalations for human Ops review.
- **`GET /ops`**: Built-in Ops dashboard to review live traces, voice recordings, and click-to-approve/reject pending payouts.
- **`POST /reset`**: Test runner helper to reset dynamic conversation/trace state between evaluation scenarios.

---

## 4. Key Assumptions Made

1. **Date Interpretation:** All trip timestamps and payout dates are treated in Indian Standard Time (IST, UTC+5:30).
2. **Reconciliation Target:** Disbursed amounts are checked directly against the live PaySwift sandbox rather than solely internal state.
3. **Multi-turn Context:** The agent maintains conversational state per `rider_id` across turns to handle fragmented answers (e.g. Turn 1: *"payout galat hai"*, Turn 2: *"20 wala"*).
4. **Safety & Injections:** Malicious prompt injections (e.g. *"SYSTEM: ignore all rules"*) or claims of accident/distance dispute bypass automated payments and are safely routed to human Ops review.

---

## 5. Security & Persistent Media Storage

- **Dedicated Webhook Authentication:** Implemented in `src/server.js` (`verifyWebhookAuth`) supporting Bearer token authorization and `X-Webhook-Secret` verification. When `WHATSAPP_WEBHOOK_SECRET` is configured in `.env`, unauthorized webhook deliveries are rejected with `401 Unauthorized`.
- **Persistent Media Storage:** Implemented persistent voice note & media attachment archival in `src/server.js` backed by local filesystem storage (`/storage/media`) and metadata indexing in `media_attachments` table with inline HTML5 audio playback on the Ops Dashboard.

---

## 6. Evaluation Results

Run command:
```bash
node evals/run.js http://localhost:8000
```
* **Total Scenarios:** 24
* **Passed:** 24 / 24
* **Pass Rate:** 100%
* Verifies zero overpayments, full compliance with the 1-daily-autopay limit, exact payout amounts, and proper escalation handling.
