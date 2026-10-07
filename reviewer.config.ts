import { Schema } from "effect";
import manifest from "./reviewer.json" with { type: "json" };
import { Manifest, strictManifestOptions } from "./src/Management.ts";
import type { ReviewerConfig } from "./src/Settings.ts";

const decoded = Schema.decodeUnknownSync(Manifest, strictManifestOptions)(manifest);
const { deployment: _deployment, ...config } = decoded;

export default config satisfies ReviewerConfig;
