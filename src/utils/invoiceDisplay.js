export function displayText(value, fallback = "Not provided") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function displayDate(value) {
  if (!value) return "Not provided";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not provided" : date.toISOString().slice(0, 10);
}

export function invoiceNumber(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function displayMoney(value) {
  const number = invoiceNumber(value);
  return number === null ? "Not available" : number.toFixed(2);
}

export function drawCompanyHeader(doc, env = process.env) {
  doc.fontSize(20).font("Helvetica-Bold").text(displayText(env.COMPANY_NAME, "Company name not configured"), 50, 50, { width: 495 });
  doc.fontSize(10).font("Helvetica");
  doc.text(`Address: ${displayText(env.COMPANY_ADDRESS, "Not configured")}`, { width: 495 });
  doc.text(`GSTIN: ${displayText(env.COMPANY_GSTIN, "Not configured")}`, { width: 495 });
  doc.text(`CIN: ${displayText(env.COMPANY_CIN, "Not configured")}`, { width: 495 });
  doc.moveDown();
}
