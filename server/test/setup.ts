import { afterAll } from "vitest";
import { startFake } from "./fake.js";

// One fixture server per test file; the real provider/search/media code is pointed at it through the *_URL settings.
const fake = await startFake();
afterAll(async () => { await fake.close(); });
