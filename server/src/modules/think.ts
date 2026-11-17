import type { RouteEvent, RouteOptions } from "../router/router.js";
import { runRouted } from "../router/router.js";

/** Replaced in phase 11 with the multi-candidate + judge pipeline. Until then Think falls back to normal routing. */
export async function* runThink(opts: RouteOptions): AsyncGenerator<RouteEvent & { type: string }> {
  yield* runRouted(opts) as AsyncGenerator<RouteEvent & { type: string }>;
}
