import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import { Effect, Layer } from "effect";
import Reviewer from "./src/Worker.ts";

export default Alchemy.Stack(
  "reviewer",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const reviewer = yield* Reviewer;
    return { url: reviewer.url.as<string>() };
  }),
);
