import "dotenv/config";
import OpenAI from "openai";
import { EktAssistantRuntime } from "../app/ekt-assistant.js";
import { extractAttachment } from "../attachments/index.js";
import { createHttpApp } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a TCP port");

const publicOrigin = process.env.PUBLIC_APP_URL ?? `http://localhost:${port}`;
const openai = new OpenAI();
const runtime = new EktAssistantRuntime({ appBaseUrl: publicOrigin, openai });
const pages = Number(process.env.EKT_INDEX_MAX_PAGES ?? 20);
if (!Number.isSafeInteger(pages) || pages < 1 || pages > 500) throw new Error("EKT_INDEX_MAX_PAGES must be 1-500");

const coverage = await runtime.warmCatalogIndex(pages);
const app = await createHttpApp({
  runtime,
  publicOrigin,
  attachmentExtractor: ({ buffer, filename, mimeType }) => extractAttachment({
    buffer,
    filename,
    mimeType,
    client: openai,
    model: process.env.OPENAI_MODEL ?? "gpt-6-sol",
  }),
});

await app.listen({ host: "0.0.0.0", port });
app.log.info({ port, coverage }, "EKT assistant ready");
