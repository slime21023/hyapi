import { run } from "./src/main.ts";

if (import.meta.main) {
  try {
    await run(Deno.args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    Deno.exit(1);
  }
}
