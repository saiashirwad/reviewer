import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { Layer, type Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/**
 * OpenCode Go serves most of its models over OpenAI-compatible chat completions.
 * Models behind `/responses` (GPT, Grok) or `/messages` (Qwen, MiniMax) need a
 * different Effect AI client and are not supported here.
 */
export const OPENCODE_GO_API_URL = "https://opencode.ai/zen/go/v1";

export const DEFAULT_MODEL = "muse-spark-1.3-contributor";

const USER_AGENT = "reviewer/0.1";

/**
 * OpenCode Go only accepts coding-agent traffic that names its client and sends
 * a stable `x-opencode-session` per conversation, which it uses for routing and
 * prompt caching. One review is one conversation.
 * See https://opencode.ai/docs/go/#where-can-i-use-it
 */
export const OpenCodeGoClient = (options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly sessionId: string;
}) =>
  OpenAiClient.layer({
    apiKey: options.apiKey,
    apiUrl: OPENCODE_GO_API_URL,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({
        "user-agent": USER_AGENT,
        "x-opencode-session": options.sessionId,
      }),
    ),
  }).pipe(Layer.provide(FetchHttpClient.layer));

export const model = (id: string) => OpenAiLanguageModel.model(id);
