import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { z, ZodError } from "zod";
import { CartError, type CartProvider } from "../cart/provider.js";
import { AttachmentExtractionError, MAX_ATTACHMENT_BYTES, type AttachmentExtraction } from "../attachments/index.js";
import type { CatalogReader } from "../agent/tools.js";
import type { AssistantHistoryItem, AssistantTurnResult } from "../agent/runner.js";
import { presentAssistantTurn } from "../app/presenter.js";

const COOKIE_NAME = "ekt_demo_session";
const MAX_HISTORY_ITEMS = 6; // Keep the last 3 user/assistant turns for follow-up context.
const chatInput = z.object({ message: z.string().trim().min(1).max(4_000) }).strict();
const confirmInput = z.object({ proposalId: z.string().uuid() }).strict();

type Runtime = {
  run(turn: { sessionId: string; message: string; history?: AssistantHistoryItem[] }): Promise<AssistantTurnResult>;
  cart: CartProvider;
  catalog: CatalogReader;
};

export type AttachmentExtractor = (input: { buffer: Buffer; filename: string; mimeType: string }) => Promise<AttachmentExtraction>;

export type HttpAppOptions = {
  runtime: Runtime;
  attachmentExtractor?: AttachmentExtractor;
  publicOrigin?: string;
};

type Session = {
  id: string;
  csrfToken: string;
  history: AssistantHistoryItem[];
};

/** Thin HTTP adapter. Only /api/cart/confirm can write to the cart. */
export async function createHttpApp(options: HttpAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: MAX_ATTACHMENT_BYTES + 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 } });
  const sessions = new Map<string, Session>();
  const secureCookie = options.publicOrigin?.startsWith("https://") ?? false;

  function sessionFor(request: FastifyRequest, reply: FastifyReply): Session {
    const existing = request.cookies[COOKIE_NAME];
    if (existing) {
      const session = sessions.get(existing);
      if (session) return session;
    }
    const session: Session = { id: randomUUID(), csrfToken: randomUUID(), history: [] };
    sessions.set(session.id, session);
    reply.setCookie(COOKIE_NAME, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookie,
    });
    return session;
  }

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: "INVALID_INPUT", message: "Некорректные данные запроса" } });
    }
    if (error instanceof CartError) {
      const status = error.code === "PROPOSAL_NOT_FOUND" ? 404
        : error.code === "INSUFFICIENT_STOCK" || error.code === "PRICE_CHANGED" || error.code === "ORDER_MULTIPLE_CHANGED" || error.code === "PROPOSAL_EXPIRED" ? 409 : 400;
      return reply.code(status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof AttachmentExtractionError) {
      const status = error.code === "INVALID_ATTACHMENT" ? 400 : 502;
      return reply.code(status).send({ error: { code: error.code, message: error.message } });
    }
    if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: { code: "INVALID_INPUT", message: "Некорректный запрос" } });
    }
    return reply.code(502).send({ error: { code: "UPSTREAM_ERROR", message: "Сервис временно недоступен" } });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/session", async (request, reply) => {
    const session = sessionFor(request, reply);
    return { csrfToken: session.csrfToken, cart: await options.runtime.cart.getCart(session.id) };
  });

  app.post("/api/chat", async (request, reply) => {
    const session = sessionFor(request, reply);
    const { message } = chatInput.parse(request.body);
    const result = await options.runtime.run({ sessionId: session.id, message, history: session.history });
    const presentation = await presentAssistantTurn(result, options.runtime.catalog);
    session.history.push({ role: "user", content: message }, { role: "assistant", content: presentation.reply });
    session.history = session.history.slice(-MAX_HISTORY_ITEMS);
    return presentation;
  });

  app.get("/api/cart", async (request, reply) => {
    const session = sessionFor(request, reply);
    return options.runtime.cart.getCart(session.id);
  });

  // A functional fallback until the teammate's styled cart route is deployed.
  app.get("/cart", async (request, reply) => {
    const session = sessionFor(request, reply);
    const cart = await options.runtime.cart.getCart(session.id);
    const items = cart.items.map((item) =>
      `<li>${escapeHtml(item.name)} — ${escapeHtml(item.city)}: ${item.quantity} × ${(item.unitPriceMinor / 100).toFixed(2)} ₸</li>`
    ).join("");
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Корзина EKT Demo</title><body style="font:16px system-ui;max-width:760px;margin:40px auto;padding:0 20px"><h1>Корзина</h1>${items ? `<ul>${items}</ul>` : "<p>Корзина пуста</p>"}<p>Итого: ${(cart.totalMinor / 100).toFixed(2)} ₸</p><p>Демонстрационная корзина прототипа</p></body></html>`;
  });

  app.post("/api/cart/confirm", async (request, reply) => {
    const session = sessionFor(request, reply);
    const origin = request.headers.origin;
    if (origin && options.publicOrigin && origin !== options.publicOrigin) {
      return reply.code(403).send({ error: { code: "INVALID_ORIGIN", message: "Недопустимый источник запроса" } });
    }
    if (request.headers["x-csrf-token"] !== session.csrfToken) {
      return reply.code(403).send({ error: { code: "INVALID_CSRF", message: "Обновите страницу и попробуйте снова" } });
    }
    const { proposalId } = confirmInput.parse(request.body);
    const confirmed = await options.runtime.cart.confirm({ sessionId: session.id, proposalId, confirmed: true });
    return { cart: confirmed.cart, alreadyConfirmed: confirmed.alreadyConfirmed };
  });

  app.post("/api/attachments", async (request, reply) => {
    sessionFor(request, reply);
    if (!options.attachmentExtractor) {
      return reply.code(503).send({ error: { code: "ATTACHMENTS_UNAVAILABLE", message: "Разбор файлов пока недоступен" } });
    }
    const file = await request.file();
    if (!file || file.fieldname !== "file") {
      return reply.code(400).send({ error: { code: "INVALID_FILE", message: "Прикрепите один файл" } });
    }
    const buffer = await file.toBuffer();
    return options.attachmentExtractor({ buffer, filename: file.filename, mimeType: file.mimetype });
  });

  return app;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character] ?? character);
}
