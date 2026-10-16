import fs from "node:fs";
import zlib from "node:zlib";
import { VISION_TEST_IMAGE_BASE64, VISION_TEST_IMAGE_DATA_URL } from "../src/utils/ai/testFixtures.js";
import { sanitizeErrorForAdmin } from "../src/utils/ai/modelAccess.js";

/**
 * Regression: the compatibility test's vision check used a hard-coded 1x1 PNG that OpenAI rejects
 * (400 image_parse_error "You uploaded an unsupported image."), so every vision-capable model
 * failed regardless of health. The fixture must be a normal, valid RGB PNG.
 */
const OLD_1X1_FIXTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";

const parsePng = (b64) => {
  const buf = Buffer.from(b64, "base64");
  expect([...buf.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    chunks.push({ type, data, crcOk: (zlib.crc32(buf.subarray(off + 4, off + 8 + len)) >>> 0) === crc });
    off += 12 + len;
  }
  return { buf, chunks };
};

describe("vision compatibility-test image", () => {
  const { chunks } = parsePng(VISION_TEST_IMAGE_BASE64);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);

  test("is a structurally valid PNG: IHDR first, IEND last, every chunk CRC correct", () => {
    expect(chunks[0].type).toBe("IHDR");
    expect(chunks[chunks.length - 1].type).toBe("IEND");
    expect(chunks.every((c) => c.crcOk)).toBe(true);
  });

  test("is a normal image OpenAI accepts: not 1x1, 8-bit RGB (color type 2)", () => {
    expect(width).toBeGreaterThanOrEqual(8);
    expect(height).toBeGreaterThanOrEqual(8);
    expect(ihdr[8]).toBe(8); // bit depth
    expect(ihdr[9]).toBe(2); // RGB (the old fixture was grayscale+alpha)
  });

  test("pixel data decompresses to exactly height x (1 filter byte + width x 3)", () => {
    const idat = Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data));
    expect(zlib.inflateSync(idat).length).toBe(height * (1 + width * 3));
  });

  test("is small (the test is billable) and exposed as a data URL", () => {
    expect(Buffer.from(VISION_TEST_IMAGE_BASE64, "base64").length).toBeLessThan(2048);
    expect(VISION_TEST_IMAGE_DATA_URL).toBe(`data:image/png;base64,${VISION_TEST_IMAGE_BASE64}`);
  });

  test("the known-bad 1x1 image is not the fixture, and is gone from the catalog service", () => {
    expect(VISION_TEST_IMAGE_BASE64).not.toBe(OLD_1X1_FIXTURE);
    const service = fs.readFileSync(new URL("../src/models/AiModelCatalogModel/catalog.service.js", import.meta.url), "utf8");
    expect(service).not.toContain(OLD_1X1_FIXTURE);
    expect(service).toContain("VISION_TEST_IMAGE_DATA_URL");
  });
});

describe("sanitizeErrorForAdmin — provider error detail", () => {
  const providerError = (props) => Object.assign(new Error("free text that may echo the prompt: sk-abcdef1234567890 hello"), props);

  test("a 400 shows OpenAI's machine-readable code so the cause is visible", () => {
    const msg = sanitizeErrorForAdmin(providerError({ status: 400, code: "image_parse_error" }), "vision");
    expect(msg).toBe("[vision] Compatibility test failed (400, image_parse_error).");
  });

  test("never includes the provider's free-text message or credentials", () => {
    const msg = sanitizeErrorForAdmin(providerError({ status: 400, code: "image_parse_error" }), "vision");
    expect(msg).not.toMatch(/free text|prompt|sk-|hello/i);
  });

  test("an unsafe / odd code is omitted rather than echoed", () => {
    for (const code of ["Has Spaces And Text", "x", "a".repeat(80), "UPPER_CASE", "sk-secret_key_value"]) {
      expect(sanitizeErrorForAdmin(providerError({ status: 400, code }), "vision")).toBe("[vision] Compatibility test failed (400).");
    }
  });

  test("no status and no code keeps the plain wording", () => {
    expect(sanitizeErrorForAdmin(new Error("boom"), "vision")).toBe("[vision] Compatibility test failed.");
  });

  test("existing specific messages are unchanged (401 / 429 / 403)", () => {
    expect(sanitizeErrorForAdmin(providerError({ status: 401 }), "access")).toMatch(/authentication failed/i);
    expect(sanitizeErrorForAdmin(providerError({ status: 429 }), "access")).toMatch(/rate limited/i);
    expect(sanitizeErrorForAdmin(providerError({ status: 403 }), "access")).toMatch(/cannot access the model/i);
  });
});
