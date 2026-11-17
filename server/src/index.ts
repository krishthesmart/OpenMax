import { cfg } from "./config.js";
import { buildApp } from "./app.js";
import "./routes/all.js";
import { bootTasks } from "./boot.js";

const app = await buildApp({ logger: false });
await app.listen({ port: cfg.PORT, host: cfg.HOST });
console.log(`OpenMax listening on http://${cfg.HOST}:${cfg.PORT}${cfg.OPENMAX_STUB ? "  (STUB MODE)" : ""}`);
bootTasks().catch((e) => console.error("boot task failed:", e.message));
const stop = async () => { await app.close(); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
