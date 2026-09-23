import { describe, expect, it, vi } from "vitest";
import {
  AttachmentExtractionError,
  MAX_ATTACHMENT_BYTES,
  extractAttachment,
  type AttachmentResponsesClient,
} from "../../src/attachments/index.js";

const item = {
  source_row: 2,
  article: "200300285_",
  name: "Автоматический выключатель",
  quantity: 3,
  unit: "шт",
  uncertainty: "none",
};

function mockClient(output: unknown = { items: [item], uncertainties: [] }, status = "completed") {
  const create = vi.fn().mockResolvedValue({ status, output_text: JSON.stringify(output) });
  return { client: { responses: { create } } as unknown as AttachmentResponsesClient, create };
}

const samples = [
  { filename: "order.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nexample"), inputType: "input_file" },
  { filename: "order.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), inputType: "input_file" },
  { filename: "order.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), inputType: "input_file" },
  { filename: "order.jpeg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), inputType: "input_image" },
  { filename: "order.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), inputType: "input_image" },
] as const;

describe("extractAttachment", () => {
  it.each(samples)("sends $filename as $inputType with strict output format", async (sample) => {
    const { client, create } = mockClient();
    const result = await extractAttachment({ ...sample, client, model: "vision-test-model" });

    expect(result).toEqual({ items: [item], uncertainties: [] });
    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0];
    expect(request.model).toBe("vision-test-model");
    expect(request.store).toBe(false);
    expect(request.tools).toBeUndefined();
    expect(request.text.format.type).toBe("json_schema");
    expect(request.text.format.strict).toBe(true);
    expect(request.input[0].content[1].type).toBe(sample.inputType);
    const attachment = request.input[0].content[1];
    if (sample.inputType === "input_image") {
      expect(attachment.image_url).toBe(`data:${sample.mimeType};base64,${sample.buffer.toString("base64")}`);
      expect(attachment.detail).toBe("high");
    } else {
      expect(attachment.file_data).toBe(`data:${sample.mimeType};base64,${sample.buffer.toString("base64")}`);
      expect(attachment.filename).toBe(sample.filename);
    }
    expect(request.instructions).toContain("untrusted data");
  });

  it.each([
    { filename: "order.pdf", mimeType: "image/jpeg", buffer: Buffer.from("%PDF-1.7") },
    { filename: "order.exe", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
    { filename: "../order.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") },
    { filename: "order.pdf", mimeType: "application/pdf", buffer: Buffer.from("not-a-pdf") },
    { filename: "order.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
    { filename: "order.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) },
  ])("rejects invalid attachment $filename before the API call", async (sample) => {
    const { client, create } = mockClient();
    await expect(extractAttachment({ ...sample, client, model: "test-model" }))
      .rejects.toMatchObject({ code: "INVALID_ATTACHMENT" } satisfies Partial<AttachmentExtractionError>);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects incomplete and malformed model responses without returning raw content", async () => {
    const incomplete = mockClient({ items: [item], uncertainties: [] }, "incomplete");
    await expect(extractAttachment({ ...samples[0], client: incomplete.client, model: "test-model" }))
      .rejects.toMatchObject({ code: "MODEL_OUTPUT_UNAVAILABLE" });

    const malformed = mockClient({ items: [{ ...item, quantity: -2 }], uncertainties: [] });
    await expect(extractAttachment({ ...samples[0], client: malformed.client, model: "test-model" }))
      .rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });

    const invalidJson = mockClient();
    invalidJson.create.mockResolvedValue({ status: "completed", output_text: "{" });
    await expect(extractAttachment({ ...samples[0], client: invalidJson.client, model: "test-model" }))
      .rejects.toMatchObject({ code: "INVALID_MODEL_OUTPUT" });
  });

  it("omits payment data and reports uncertainty", async () => {
    const { client } = mockClient({
      items: [item, { ...item, article: null, name: "CVV 123", source_row: 3 }, { ...item, article: "4111 1111 1111 1111", source_row: 4 }],
      uncertainties: [],
    });
    const result = await extractAttachment({ ...samples[0], client, model: "test-model" });

    expect(result.items).toEqual([item]);
    expect(result.uncertainties).toContain("sensitive_content_omitted");
    expect(JSON.stringify(result)).not.toContain("CVV 123");
    expect(JSON.stringify(result)).not.toContain("4111");
  });

  it("limits returned rows and marks an empty extraction", async () => {
    const many = mockClient({ items: Array.from({ length: 101 }, (_, index) => ({ ...item, source_row: index + 1 })), uncertainties: [] });
    const limited = await extractAttachment({ ...samples[0], client: many.client, model: "test-model" });
    expect(limited.items).toHaveLength(100);
    expect(limited.uncertainties).toContain("result_limited");

    const empty = mockClient({ items: [], uncertainties: [] });
    const noItems = await extractAttachment({ ...samples[0], client: empty.client, model: "test-model" });
    expect(noItems).toEqual({ items: [], uncertainties: ["no_items_found"] });
  });
});
