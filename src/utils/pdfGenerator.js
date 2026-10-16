// backend/src/utils/pdfGenerator.js

import PDFDocument from "pdfkit";
import { displayText, displayDate, displayMoney, invoiceNumber, drawCompanyHeader } from "./invoiceDisplay.js";


// Helper: Convert number to words (Indian Rupees)
function numberToWords(amount) {
  // Only supports up to 99,99,99,999.99
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  const units = [
    { name: "Crore", value: 10000000 },
    { name: "Lakh", value: 100000 },
    { name: "Thousand", value: 1000 },
    { name: "Hundred", value: 100 },
  ];

  function numToWords(n) {
    let str = "";
    if (n > 99) {
      for (const u of units) {
        if (n >= u.value) {
          const q = Math.floor(n / u.value);
          str += numToWords(q) + " " + u.name + " ";
          n = n % u.value;
        }
      }
    }
    if (n > 19) {
      str += tens[Math.floor(n / 10)] + " ";
      n = n % 10;
    }
    if (n > 0) {
      str += ones[n] + " ";
    }
    return str.trim();
  }

  const [rupees, paise] = amount.toFixed(2).split(".");
  let words = "";
  const rupeeNum = parseInt(rupees, 10);
  const paiseNum = parseInt(paise, 10);
  if (rupeeNum === 0) {
    words = "Zero Rupees";
  } else {
    words = "Rupees " + numToWords(rupeeNum);
  }
  if (paiseNum > 0) {
    words += " and " + numToWords(paiseNum) + " Paise";
  }
  words += " Only";
  return words;
}

async function generateInvoicePdf(invoiceId, tenantId) {
  const { default: db } = await import("../database/index.js");
  const { MonthlyInvoices: MonthlyInvoice, BillingCycles: BillingCycle, PaymentHistory } = db;
  // Fetch invoice, billing cycle, tenant
  const whereClause = tenantId
    ? { id: invoiceId, tenant_id: tenantId }
    : { id: invoiceId };
  console.log("[PDF] Looking up invoice:", JSON.stringify(whereClause));
  const invoice = await MonthlyInvoice.findOne({ where: whereClause });
  if (!invoice) {
    console.error("[PDF] Invoice NOT FOUND for:", JSON.stringify(whereClause));
    throw { code: "NOT_FOUND", message: "Invoice not found", statusCode: 404 };
  }
  console.log("[PDF] Invoice found, tenant_id:", invoice.tenant_id);

  // Use raw SQL query to match the auth middleware lookup pattern exactly.
  // The Sequelize Tenant.findOne() was returning null despite the tenant
  // existing — likely a column-mapping or collation mismatch.
  const [tenantRows] = await db.sequelize.query(
    "SELECT * FROM tenants WHERE tenant_id = ? AND is_deleted = 0 LIMIT 1",
    { replacements: [invoice.tenant_id] },
  );
  const tenant = tenantRows[0];
  if (!tenant) {
    console.error("[PDF] Tenant NOT FOUND for tenant_id:", invoice.tenant_id);
    throw { code: "NOT_FOUND", message: "Tenant not found", statusCode: 404 };
  }

  const billingCycle = await BillingCycle.findOne({
    where: { id: invoice.billing_cycle_id, tenant_id: invoice.tenant_id },
  });
  const payment = await PaymentHistory.findOne({
    where: { invoice_number: invoice.invoice_number, tenant_id: invoice.tenant_id, status: "success" },
    order: [["createdAt", "DESC"]],
  });

  return renderInvoicePdf(invoice, tenant, billingCycle, payment);
}

export function renderInvoicePdf(invoice, tenant, billingCycle = null, payment = null, env = process.env) {
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const chunks = [];
  doc.on("data", chunk => chunks.push(chunk));
  const result = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const line = (text, options = {}) => doc.text(text, 50, doc.y, { width: 495, ...options });
  const rule = () => {
    if (doc.y > doc.page.height - 70) doc.addPage();
    doc.moveTo(50, doc.y + 5).lineTo(545, doc.y + 5).stroke();
    doc.y += 15;
  };
  // Measure every row so wrapped text and page breaks do not overlap later rows.
  const row = (values, widths) => {
    const height = Math.max(...values.map((value, index) => doc.heightOfString(value, { width: widths[index] - 10 }))) + 10;
    if (doc.y + height > doc.page.height - 50) doc.addPage();
    const top = doc.y;
    let x = 50;
    values.forEach((value, index) => {
      doc.text(value, x, top, { width: widths[index] - 10, align: index === values.length - 1 ? "right" : "left" });
      x += widths[index];
    });
    doc.x = 50;
    doc.y = top + height;
  };

  drawCompanyHeader(doc, env);
  doc.fontSize(12).font("Helvetica-Bold");
  line("TAX INVOICE", { align: "right" });
  doc.fontSize(10).font("Helvetica");
  line("Invoice #: " + displayText(invoice.invoice_number, String(invoice.id ?? "Not provided")), { align: "right" });
  line("Date: " + displayDate(invoice.invoice_date || invoice.createdAt || invoice.created_at), { align: "right" });
  line("Due Date: " + displayDate(invoice.due_date), { align: "right" });
  rule();
  doc.fontSize(12).font("Helvetica-Bold");
  line("Bill To:");
  doc.fontSize(10).font("Helvetica");
  line(displayText(tenant.company_name, displayText(tenant.name)));
  line("Address: " + displayText(tenant.address));
  const locality = [tenant.city, tenant.pincode, tenant.country].map(value => displayText(value, "")).filter(Boolean).join(", ");
  if (locality) line(locality);
  line("GSTIN: " + displayText(invoice.tenant_gstin, "Not recorded"));
  line("State: " + displayText(invoice.tenant_state, "Not recorded"));
  doc.moveDown();

  const period = billingCycle ? displayDate(billingCycle.start_date) + " to " + displayDate(billingCycle.end_date) : "Not provided";
  doc.font("Helvetica-Bold");
  row(["Description", "Period", "Amount (INR)"], [225, 165, 105]);
  rule();
  doc.font("Helvetica");
  row(["WhatsApp message charges", period, displayMoney(invoice.total_message_cost_inr)], [225, 165, 105]);
  row(["AI model usage charges", period, displayMoney(invoice.total_ai_cost_inr)], [225, 165, 105]);
  rule();
  doc.font("Helvetica-Bold");
  row(["Subtotal", displayMoney(invoice.base_amount)], [330, 165]);
  doc.font("Helvetica");

  const base = invoiceNumber(invoice.base_amount);
  const gst = invoiceNumber(invoice.gst_amount);
  const rate = invoiceNumber(invoice.gst_rate) ?? (base > 0 && gst !== null ? gst / base * 100 : null);
  const taxLabel = (name, value) => value === null ? name + " (rate not recorded)" : name + " @ " + Number(value.toFixed(2)) + "%";
  const cgst = invoiceNumber(invoice.cgst_amount);
  const sgst = invoiceNumber(invoice.sgst_amount);
  const igst = invoiceNumber(invoice.igst_amount);
  const sameState = displayText(invoice.tenant_state, "").toUpperCase() === displayText(invoice.company_state, "").toUpperCase();
  const hasStates = !!displayText(invoice.tenant_state, "") && !!displayText(invoice.company_state, "");
  // Prefer recorded tax components; missing states must not imply intra-state tax.
  if (cgst > 0 || sgst > 0 || (igst === 0 && hasStates && sameState)) {
    row([taxLabel("CGST", rate === null ? null : rate / 2), displayMoney(invoice.cgst_amount)], [330, 165]);
    row([taxLabel("SGST", rate === null ? null : rate / 2), displayMoney(invoice.sgst_amount)], [330, 165]);
  }
  if (igst > 0 || (hasStates && !sameState && !(cgst > 0 || sgst > 0))) {
    row([taxLabel("IGST", rate), displayMoney(invoice.igst_amount)], [330, 165]);
  } else if (!(cgst > 0 || sgst > 0 || (igst === 0 && hasStates && sameState))) {
    row([taxLabel("GST", rate), displayMoney(invoice.gst_amount)], [330, 165]);
  }
  rule();
  const total = invoiceNumber(invoice.total_amount) ?? invoiceNumber(invoice.amount);
  doc.fontSize(12).font("Helvetica-Bold");
  row(["TOTAL (INR)", displayMoney(total)], [330, 165]);
  doc.fontSize(10).font("Helvetica-Oblique");
  line("Amount in words: " + (total === null ? "Not available" : numberToWords(total)));
  doc.moveDown();
  doc.font("Helvetica");

  if (payment || invoice.paid_at || displayText(invoice.payment_reference, "")) {
    doc.font("Helvetica-Bold");
    line("Payment Details:");
    doc.font("Helvetica");
    line("Payment Method: " + displayText(payment?.payment_method));
    line("Payment ID: " + displayText(payment?.razorpay_payment_id, displayText(invoice.payment_reference)));
    line("Payment Date: " + displayDate(invoice.paid_at || payment?.createdAt || payment?.created_at));
    doc.moveDown();
  }
  doc.font("Helvetica-Bold");
  line("Status: " + displayText(invoice.status, "Not recorded").toUpperCase());
  doc.moveDown();
  doc.fontSize(9).font("Helvetica").fillColor("#666");
  line("This is a computer-generated invoice. No signature required.");
  line("HSN/SAC: " + displayText(invoice.hsn_sac_code, "Not recorded"));
  line("Payment due date: " + displayDate(invoice.due_date));
  doc.end();
  return result;
}

async function generateReceiptPdf(paymentId, tenantId) {
  const { default: db } = await import("../database/index.js");
  const { PaymentHistory } = db;
  const whereClause = tenantId
    ? { id: paymentId, tenant_id: tenantId }
    : { id: paymentId };
  console.log("[PDF] Looking up payment:", JSON.stringify(whereClause));
  const payment = await PaymentHistory.findOne({ where: whereClause });
  if (!payment) {
    console.error("[PDF] Payment NOT FOUND for:", JSON.stringify(whereClause));
    throw { code: "NOT_FOUND", message: "Payment receipt not found", statusCode: 404 };
  }

  // Look up tenant using raw SQL to be reliable
  const [tenantRows] = await db.sequelize.query(
    "SELECT * FROM tenants WHERE tenant_id = ? AND is_deleted = 0 LIMIT 1",
    { replacements: [payment.tenant_id] },
  );
  const tenant = tenantRows[0];
  if (!tenant) {
    console.error("[PDF] Tenant NOT FOUND for tenant_id:", payment.tenant_id);
    throw { code: "NOT_FOUND", message: "Tenant not found", statusCode: 404 };
  }


  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const chunks = [];

  doc.on("data", (chunk) => chunks.push(chunk));

  const pdfPromise = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Header
  drawCompanyHeader(doc);

  // Receipt details (right side)
  doc
    .fontSize(12)
    .font("Helvetica-Bold")
    .text("PAYMENT RECEIPT", { align: "right" });
  doc.fontSize(10).font("Helvetica");
  doc.text(`Receipt #: ${payment.invoice_number || `REC-${payment.id}`}`, {
    align: "right",
  });
  doc.text(
    `Date: ${new Date(payment.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}`,
    { align: "right" },
  );
  doc.text(
    `Time: ${new Date(payment.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`,
    { align: "right" },
  );
  doc.moveDown();

  // Line separator
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown();

  // Bill To section
  doc.fontSize(12).font("Helvetica-Bold").text("Received From:");
  doc.fontSize(10).font("Helvetica");
  doc.text(displayText(tenant.company_name, displayText(tenant.name)));
  doc.text(`Address: ${displayText(tenant.address)}`);
  doc.text(`Tenant ID: ${tenant.tenant_id}`);
  doc.moveDown();

  // Transaction details table header
  const tableTop = doc.y;
  doc.fontSize(10).font("Helvetica-Bold");
  doc.text("Description", 50, tableTop);
  doc.text("Reference ID / Method", 250, tableTop);
  doc.text("Amount (INR)", 450, tableTop, { width: 95, align: "right" });

  doc
    .moveTo(50, tableTop + 15)
    .lineTo(545, tableTop + 15)
    .stroke();

  let y = tableTop + 25;
  doc.font("Helvetica");

  // Payment Details Row
  doc.text(payment.description || "Wallet Recharge", 50, y, { width: 190 });
  const methodAndId = `${payment.payment_method || "Online"} | ${payment.razorpay_payment_id || "N/A"}`;
  doc.text(methodAndId, 250, y, { width: 190 });
  
  const grossAmt = parseFloat(payment.gross_amount || payment.amount || 0);
  const baseAmt = parseFloat(payment.base_amount || payment.amount || 0);
  const gstAmt = parseFloat(payment.gst_amount || 0);
  
  doc.text(`${grossAmt.toFixed(2)}`, 450, y, {
    width: 95,
    align: "right",
  });
  y += 35;

  // Subtotal / Breakdown section
  doc.moveTo(50, y).lineTo(545, y).stroke();
  y += 10;
  
  doc.font("Helvetica-Bold");
  doc.text("Taxable Value (Credited)", 300, y);
  doc.text(`${baseAmt.toFixed(2)}`, 450, y, {
    width: 95,
    align: "right",
  });
  y += 20;

  doc.font("Helvetica");
  if (gstAmt > 0) {
    const isIntra = Boolean(payment.is_intra_state);
    if (isIntra) {
      const halfGst = (gstAmt / 2).toFixed(2);
      doc.text("CGST (9%)", 300, y);
      doc.text(`${halfGst}`, 450, y, { width: 95, align: "right" });
      y += 15;
      doc.text("SGST (9%)", 300, y);
      doc.text(`${halfGst}`, 450, y, { width: 95, align: "right" });
      y += 15;
    } else {
      doc.text("IGST (18%)", 300, y);
      doc.text(`${gstAmt.toFixed(2)}`, 450, y, { width: 95, align: "right" });
      y += 15;
    }
  } else {
    doc.text("GST (0%)", 300, y);
    doc.text("0.00", 450, y, { width: 95, align: "right" });
    y += 15;
  }

  // Total Paid
  doc.moveTo(300, y).lineTo(545, y).stroke();
  y += 10;
  doc.fontSize(12).font("Helvetica-Bold");
  doc.text("TOTAL PAID", 300, y);
  doc.text(`INR ${grossAmt.toFixed(2)}`, 450, y, {
    width: 95,
    align: "right",
  });
  y += 25;

  // Amount in words
  doc.fontSize(10).font("Helvetica-Oblique");
  doc.text(
    `Amount in words: ${numberToWords(grossAmt)}`,
    50,
    y,
  );
  y += 30;

  // Wallet details
  doc.fontSize(10).font("Helvetica-Bold").text("Wallet Balance Update:", 50, y);
  y += 15;
  doc.font("Helvetica");
  doc.text(`Balance Before: INR ${parseFloat(payment.balance_before || 0).toFixed(2)}`, 50, y);
  y += 12;
  doc.text(`Balance After: INR ${parseFloat(payment.balance_after || 0).toFixed(2)}`, 50, y);
  y += 30;

  // Status Badge
  const statusVal = payment.status || "success";
  const statusColors = {
    success: "#27ae60",
    paid: "#27ae60",
    pending: "#f1c40f",
    failed: "#e74c3c",
    refunded: "#7f8c8d"
  };
  doc.rect(50, y, 65, 20).fill(statusColors[statusVal] || "#27ae60");
  doc.fillColor("#fff").fontSize(9).font("Helvetica-Bold");
  doc.text(statusVal.toUpperCase(), 50, y + 6, { width: 65, align: "center" });
  doc.fillColor("#000");
  y += 40;

  // Footer
  doc.fontSize(9).font("Helvetica").fillColor("#666");
  doc.text(
    "This is a computer-generated receipt. No signature required.",
    50,
    y,
  );
  y += 12;
  doc.text("HSN/SAC: 998314 — Software as a Service", 50, y);
  y += 12;
  doc.text("Thank you for using Whatnexus!", 50, y);

  doc.end();

  return pdfPromise;
}

export { generateInvoicePdf, generateReceiptPdf, numberToWords };
