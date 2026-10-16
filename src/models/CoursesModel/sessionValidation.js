export function validateSession(data) {
  const topics = ["Leadership", "Compliance", "Soft Skills", "Technical", "Sales", "HR", "Finance"];
  if (!data || typeof data.title !== "string" || !data.title.trim() || data.title.length > 255 ||
      typeof data.host !== "string" || !data.host.trim() || data.host.length > 255 || !topics.includes(data.topic)) {
    return "A title, trainer, and valid topic are required";
  }
  if (!Number.isFinite(data.scheduledMs) || data.scheduledMs <= Date.now() ||
      data.scheduledMs > 8640000000000000 || !Number.isInteger(data.durationMinutes) ||
      data.durationMinutes < 1 || data.durationMinutes > 1440) {
    return "Choose a future date and a duration between 1 and 1440 minutes";
  }
  try {
    if (typeof data.meetingLink !== "string" || data.meetingLink.length > 2048 ||
        !["https:", "http:"].includes(new URL(data.meetingLink).protocol)) throw new Error();
  } catch {
    return "A valid HTTP or HTTPS meeting link is required";
  }
  return null;
}
