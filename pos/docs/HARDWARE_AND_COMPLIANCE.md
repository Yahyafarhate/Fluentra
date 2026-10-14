# Hardware and compliance — what is and is not done

## Hardware (nothing is simulated as working)
| Device | State |
|---|---|
| Touchscreen terminals / tablets | The UI is touch-first and responsive (tablet verified in the browser journey). Not tested on physical devices. |
| Receipt printing | Browser print of a receipt page (`/pos/order/{id}/receipt`, print stylesheet). **No ESC/POS or vendor SDK adapter.** |
| Kitchen printers | **Not implemented.** The KDS covers tickets, timers, accept/start/ready/recall; there is no print-job queue, reprint or hardware abstraction layer yet. |
| KDS screens | Implemented as a web page (touch or mouse). A physical bump bar is not supported. |
| Cash drawer kick | **Not implemented** (cash sessions and counting are). |
| Barcode scanners | Not implemented. |
| Card terminals | **No real provider.** The `PaymentProvider` contract exists; the only adapter is a clearly labelled TEST terminal (off in production). A card payment can never be recorded without a provider's `succeeded`. CMI / Stripe Terminal / other adapters must be written against the provider's SDK and certified. |

Manual hardware test plan (to be run once adapters exist): print a receipt with Arabic/French characters and a long item name; kitchen ticket reprint after a paper-out; drawer opens only on cash; terminal approve / decline / cable pulled mid-payment (payment must stay *pending*, then reconcile); KDS on a dedicated tablet with the screen lock disabled.

## Moroccan regulatory questions requiring a qualified accountant / lawyer
Do **not** use this product commercially before these are answered; no certification is claimed.
1. VAT: applicable rates per item type (the defaults 10%/20%/0% are placeholders), whether service charges and tips are taxed, rounding rules.
2. Receipts/tickets: mandatory mentions (ICE, IF, RC, patente, TVA breakdown), sequential numbering, invoice vs. ticket, retention periods. The receipt shows a "not validated" notice.
3. Cash-register/fiscal device requirements, if any, and electronic invoicing obligations (DGI).
4. Payments: CMI/bank acquirer certification; PCI scope (the POS never sees card data — keep it that way); refund rules for card payments.
5. Privacy: the POS stores employees' names/PINs only; when guest identities are linked later, Law 09-08 (CNDP) declaration and consent apply.
6. Tipping and service-charge distribution rules for staff.
7. Data retention/export obligations for accounting records.
