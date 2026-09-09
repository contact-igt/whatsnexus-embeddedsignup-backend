import { runApprovedModel } from "./runApprovedModel.js";

export const analyzeImageAndReply = async ({
  imageUrl,
  caption = "",
  history = [],
  systemPrompt = "",
  tenantId = null,
}) => {
  // Build the user turn: image first, then caption/prompt text
  const userContent = [
    {
      type: "image_url",
      image_url: {
        url: imageUrl,
        detail: "low", // ~85 tokens regardless of image size — safe default; upgrade to "high" per tenant in future
      },
    },
    {
      type: "text",
      text: caption?.trim()
        ? `The user sent this image with the caption: "${caption}". Please respond helpfully based on the image and the ongoing conversation.`
        : "The user sent this image. Please describe what you see and respond helpfully based on the ongoing conversation context.",
    },
  ];

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...history,
    { role: "user", content: userContent },
  ];

  const result = await runApprovedModel({ tenantId, purpose: "vision", source: "whatsapp_vision", messages, temperature: 0.2, maxTokens: 1500 });
  return result.content;
};
