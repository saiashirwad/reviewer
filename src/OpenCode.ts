import { OpenAiClient as OpenAiClientChat, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { OpenAiClient as OpenAiClientResponses } from "@effect/ai-openai";
import { Layer, type Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/**
 * OpenCode Go serves most models over OpenAI-compatible chat completions.
 * Muse uses the Responses API. See https://opencode.ai/docs/go/#endpoints
 */
export const OPENCODE_GO_API_URL = "https://opencode.ai/zen/go/v1";

export const MUSE_MODEL = "muse-spark-1.3-contributor";
export const DEFAULT_MODEL = MUSE_MODEL;

export const USER_AGENT = "reviewer/0.1";

export type Transport = "chat" | "responses";

const sessionHeaders = (sessionId: string) =>
  HttpClient.mapRequest(
    HttpClientRequest.setHeaders({
      "user-agent": USER_AGENT,
      "x-opencode-session": sessionId,
    }),
  );

/** Chat-completions models (@effect/ai-openai-compat). */
export const chatClientLayer = (options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
}) =>
  OpenAiClientChat.layer({
    apiKey: options.apiKey,
    apiUrl: OPENCODE_GO_API_URL,
    transformClient: sessionHeaders(options.sessionId),
  }).pipe(Layer.provide(FetchHttpClient.layer));

/** Muse and other Responses-API models (@effect/ai-openai). */
export const responsesClientLayer = (options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
}) =>
  OpenAiClientResponses.layer({
    apiKey: options.apiKey,
    apiUrl: OPENCODE_GO_API_URL,
    transformClient: sessionHeaders(options.sessionId),
  }).pipe(Layer.provide(FetchHttpClient.layer));

export const model = (id: string) => OpenAiLanguageModel.model(id);

export const transportForModel = (modelId: string): Transport =>
  modelId === MUSE_MODEL ? "responses" : "chat";
