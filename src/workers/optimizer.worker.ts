/// <reference lib="webworker" />

import { optimizeAssignments } from "../lib/optimizer";
import type { OptimizerInput } from "../types";

self.onmessage = (event: MessageEvent<OptimizerInput>) => {
  self.postMessage(optimizeAssignments(event.data));
};

export {};
