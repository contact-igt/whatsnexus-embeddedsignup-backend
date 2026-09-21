/**
 * Fixtures for the live model compatibility test.
 *
 * VISION image: a 64x64 solid-red, 8-bit RGB PNG (178 bytes).
 *
 * The previous fixture was a hard-coded 1x1 PNG. OpenAI rejects it with
 * `400 image_parse_error — "You uploaded an unsupported image."`, so EVERY vision-capable
 * model failed its vision check no matter how healthy it was. This image was verified
 * against the live API (gpt-4o-mini answered "The main color in the image is red.").
 *
 * Keep it small (the test is billable) but a normal, valid RGB PNG — do not shrink it back
 * to 1x1 or switch to grayscale/alpha without re-verifying against OpenAI.
 */
export const VISION_TEST_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwCqpf1ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13PLIEAOXyUUwAAAABJRU5ErkJggg==";

export const VISION_TEST_IMAGE_DATA_URL = `data:image/png;base64,${VISION_TEST_IMAGE_BASE64}`;
