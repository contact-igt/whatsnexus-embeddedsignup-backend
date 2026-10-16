# Invoice PDF display implementation

Implemented on 2026-09-09.

## Findings

- The download endpoint uses `src/utils/pdfGenerator.js` (PDFKit). The HTML file at `public/html/invoicePdf/invoicePdf.html` is not used by this download path.
- Supplier details were read from environment variables, with `Your Company` and empty strings as fallbacks. The local environment check found `COMPANY_NAME`, `COMPANY_ADDRESS`, `COMPANY_GSTIN`, `COMPANY_CIN`, and `COMPANY_STATE` missing. Configuration values were not printed or changed.
- The monthly invoice model stores its creation date as `createdAt` / `created_at`; the PDF read only the nonexistent `invoice_date` field.
- The payment model uses `payment_method`, `razorpay_payment_id`, and `createdAt`. The PDF read `method`, `payment_id`, and `paid_at` from payment history.
- A missing customer GSTIN was incorrectly presented as `Unregistered`. Missing state and other fields produced empty labels.
- Missing totals became zero, zero GST rates could become 18%, and two missing states could be treated as the same tax jurisdiction.
- Fixed row offsets could overlap wrapped text. Amounts had inconsistent precision.

## Changes

### Supplier header

The shared header renders the supplier name, address, GSTIN, and CIN on separate wrapping lines. Invoice and receipt downloads both use it. Missing values remain explicit; the application does not invent a legal entity or registration number.

### Field mappings and empty values

| Display | Source | Empty handling |
| --- | --- | --- |
| Supplier name | `COMPANY_NAME` | `Company name not configured` |
| Supplier address | `COMPANY_ADDRESS` | `Address: Not configured` |
| Supplier GSTIN | `COMPANY_GSTIN` | `GSTIN: Not configured` |
| Supplier CIN | `COMPANY_CIN` | `CIN: Not configured` |
| Invoice number | `invoice_number`, then invoice ID | `Not provided` |
| Invoice date | `invoice_date` if available, otherwise `createdAt` / `created_at` | `Not provided` for missing or invalid dates |
| Due date | Invoice `due_date` | `Not provided` |
| Buyer | Tenant `company_name`, then `name` | `Not provided` |
| Buyer address | Tenant `address`, with available city, pincode, country on the following line | Explicit missing address; absent locality parts omitted |
| Buyer GSTIN | Invoice snapshot `tenant_gstin` | `Not recorded`; does not imply unregistered status |
| Buyer state | Invoice snapshot `tenant_state` | `Not recorded` |
| Billing period | Associated cycle start/end dates | `Not provided` for missing cycle or individual dates |
| Message / AI charges, subtotal, tax | Stored invoice amounts | `Not available` for missing or invalid values; zero remains `0.00` |
| Total | `total_amount`, then legacy `amount` | `Not available`; zero remains zero |
| Amount in words | Same resolved total | `Not available` if total is absent |
| Payment method | Successful payment's `payment_method` | `Not provided` |
| Payment reference | `razorpay_payment_id`, then invoice `payment_reference` | `Not provided` |
| Payment date | Invoice `paid_at`, then payment creation date | `Not provided` |
| Status | Invoice `status` | `NOT RECORDED` |
| HSN/SAC | Invoice `hsn_sac_code` | `Not recorded` |

Dates support both Date objects and strings and display as `YYYY-MM-DD` in UTC. Amounts display with two decimal places and `INR` labels, avoiding dependence on rupee-glyph support in the PDF's standard font. Stored values and calculations are not modified; independently rounded display amounts may differ from a displayed sum by a paisa.

### Tax display

- Uses the invoice's recorded GST rate, including zero.
- For older invoices without a rate, derives the display percentage only when a positive recorded base and recorded GST amount are available; otherwise labels the rate as not recorded.
- Prefers recorded tax components. Known state snapshots can identify zero-tax intra/inter-state rows. Missing states do not imply intra-state taxation.
- When jurisdiction/components cannot identify a split, shows the recorded GST total instead of inventing a split.
- Does not replace historical tax values with the current platform GST rate or alter billing calculations.

### Payment lookup and layout

The billing cycle and successful payment lookup are scoped to the invoice tenant. The latest successful matching payment is used. An invoice payment reference or paid date can still be displayed when no payment-history row exists.

Table rows are measured before drawing. Wrapped content has enough row height, and rows move to another page when necessary. Header, address, payment, and footer text use normal PDF text flow. The footer uses the stored due date instead of asserting a fixed payment term.

## Company configuration still required

Set the following backend environment variables to verified supplier details:

```dotenv
COMPANY_NAME=
COMPANY_ADDRESS=
COMPANY_GSTIN=
COMPANY_CIN=
COMPANY_STATE=
```

Use the actual invoice issuer, not the customer shown under Bill To. `COMPANY_STATE` is used by existing billing calculations; configure it to the correct supported state code. If a registration is not applicable, use a verified explicit value such as `Not applicable` rather than a fabricated number. This patch does not determine registration applicability or validate legal compliance.

Restart the backend after configuration, then download the invoice again. Existing PDFs in Downloads are static files and will not change. No database migration is required for this invoice display fix.

## Validation

Run from `invictus-chatbot`:

```powershell
node src/utils/invoiceDisplay.test.js
node --check src/utils/pdfGenerator.js
node --check src/utils/invoiceDisplay.js
git diff --check
```

The PDF test generates and extracts actual PDFs using the existing PDFKit and PDF.js dependencies. It checks populated fields, missing fields, invalid dates/numbers, fallback totals, zero amounts/rates, intra-state and inter-state labels, payment mappings, long addresses, and text bounds on every page. No database or live customer data is required. PDF.js may warn that optional canvas polyfills are absent; these checks extract text and coordinates rather than rasterizing pages.

## Scope and remaining limits

- Modified `src/utils/pdfGenerator.js`; added `src/utils/invoiceDisplay.js` and `src/utils/invoiceDisplay.test.js`.
- Receipt changes share the supplier header and explicit buyer-name/address fallbacks. The invoice regression checks do not cover the separate receipt financial layout.
- Supplier fields still come from current backend configuration; buyer name/address come from the current tenant record. Historical supplier/buyer identity snapshots are not added by this patch. Invoice GSTIN/state/rate/amount snapshots remain authoritative.
- No live database invoice or browser download was exercised. The reported screenshot was traced to the active PDF generator and checked with synthetic populated/empty/long-data PDFs.
- The missing real supplier details must be supplied through configuration before they can appear on downloads.
