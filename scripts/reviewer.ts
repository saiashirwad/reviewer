import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { ConfigProvider, Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { rootCommand } from "./management/Commands.ts";
import { layer as runtimeLayer, loadEnvironment } from "./management/Runtime.ts";

const program = Effect.gen(function*() {
  yield* loadEnvironment();
  yield* Command.run(rootCommand, { version: "0.0.0" }).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  );
}).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, runtimeLayer)),
);

NodeRuntime.runMain(program);
