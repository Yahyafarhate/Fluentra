# Integrations

| Integration | State |
|---|---|
| Email via SMTP (nodemailer) | **Implemented and tested** against an in-process SMTP server (delivery, header, permanent 5xx → failed without retry, 4xx/network → retry). Use any SMTP relay; Mailpit locally. |
| SMS via Twilio | Adapter written; **not verified against a live account**. |
| WhatsApp Business Cloud API | Adapter written (text messages); **not verified live**; approved templates not implemented. |
| Delivery webhooks | Endpoint `/api/webhooks/delivery` with HMAC signature verification; tested for signature handling, not against a real provider. |
| Payments (Stripe, CMI) | **Not implemented.** Deposits are recorded as "pending" requirements only. |
| POS | **Not implemented.** Revenue comes from manually recorded spend. |
| Calendar / Google Reserve | Not implemented. |

Adapter contract: `MessageAdapter { channel, provider, isConfigured(), send() }` in `src/server/notifications/adapters.ts`. Add a provider by implementing it and registering it for a channel.
