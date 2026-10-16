import assert from "node:assert/strict";
import pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import { renderInvoicePdf } from "./pdfGenerator.js";
import { displayDate, displayMoney, displayText } from "./invoiceDisplay.js";

async function readPdf(invoice, tenant, cycle, payment, company) {
  const buffer = await renderInvoicePdf(invoice, tenant, cycle, payment, company);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index++) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      assert.ok(item.transform[4] >= 49 && item.transform[4] + item.width <= 546, `Text outside horizontal margins: ${item.str}`);
      assert.ok(item.transform[5] >= 49 && item.transform[5] <= page.view[3] - 49, `Text outside vertical margins: ${item.str}`);
    }
    pages.push(content.items.map(item => item.str).join(" "));
  }
  await pdf.destroy();
  return pages.join(" ").replace(/\s+/g, " ");
}

assert.equal(displayText("  "), "Not provided");
assert.equal(displayDate("invalid"), "Not provided");
assert.equal(displayDate(null), "Not provided");
assert.equal(displayDate(new Date("2026-08-23T00:00:00Z")), "2026-08-23");
assert.equal(displayMoney(0), "0.00");
assert.equal(displayMoney(null), "Not available");
assert.equal(displayMoney("invalid"), "Not available");

const invoice = {
  id: 1, invoice_number: "INV-TEST", createdAt: "2026-08-23T00:00:00Z", due_date: "2026-09-06",
  total_message_cost_inr: "37.7016", total_ai_cost_inr: "937.9017", base_amount: "975.6000",
  gst_amount: "204.876", amount: "1180.476", total_amount: null, gst_rate: "21", igst_amount: "204.876",
  cgst_amount: 0, sgst_amount: 0, tenant_state: "KA", company_state: "TN", tenant_gstin: "TEST-BUYER-GSTIN",
  hsn_sac_code: "TEST-SAC", status: "paid", paid_at: "2026-09-01", payment_reference: "pay_reference",
};
const company = { COMPANY_NAME: "Example Supplier", COMPANY_ADDRESS: "Supplier address", COMPANY_GSTIN: "TEST-GSTIN", COMPANY_CIN: "TEST-CIN" };
const tenant = { company_name: "Example Buyer", address: "Buyer address" };
const cycle = { start_date: "2026-07-23", end_date: new Date("2026-08-22") };
const populated = await readPdf(invoice, tenant, cycle, { payment_method: "UPI", razorpay_payment_id: "pay_test" }, company);
for (const expected of ["Example Supplier", "GSTIN: TEST-GSTIN", "CIN: TEST-CIN", "Date: 2026-08-23", "1180.48", "IGST @ 21%", "Payment Method: UPI", "Payment ID: pay_test", "HSN/SAC: TEST-SAC"]) assert.ok(populated.includes(expected), expected);
assert.ok(!populated.includes("Your Company"));

const empty = await readPdf({}, {}, null, null, {});
for (const expected of ["Company name not configured", "GSTIN: Not configured", "CIN: Not configured", "Date: Not provided", "GSTIN: Not recorded", "State: Not recorded", "Not available"]) assert.ok(empty.includes(expected), expected);
assert.ok(!/Invalid Date|NaN|undefined|Unregistered|CGST|IGST/.test(empty));

const zero = await readPdf({ ...invoice, gst_rate: 0, gst_amount: 0, igst_amount: 0, total_amount: 0 }, tenant, cycle, null, company);
assert.ok(zero.includes("IGST @ 0%"));
assert.ok(zero.includes("Zero Rupees Only"));
const intra = await readPdf({ ...invoice, tenant_state: "TN", gst_rate: 18, cgst_amount: 87.804, sgst_amount: 87.804, igst_amount: 0 }, tenant, cycle, null, company);
assert.ok(intra.includes("CGST @ 9%") && intra.includes("SGST @ 9%") && !intra.includes("IGST"));
const long = await readPdf(invoice, { ...tenant, address: "Long buyer address with city and postal information. ".repeat(80) }, cycle, null,
  { ...company, COMPANY_NAME: "Long Supplier Company Name ".repeat(8), COMPANY_ADDRESS: "Long supplier address details. ".repeat(40) });
assert.ok(long.includes("TOTAL (INR)") && long.includes("Payment due date: 2026-09-06"));
console.log("Invoice PDF checks passed: populated, empty, zero tax, intra-state, long details, and page bounds.");
