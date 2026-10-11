import { assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "jsr:@std/path@^1";
import { watchEmit } from "../../../packages/cli/src/watch.ts";
import { REPO } from "../helpers.ts";

/** Polls until `condition` holds, failing after `timeoutMs`. */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

Deno.test("emit --watch rewrites the document when a contract changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hyapi-watch-" });
  const contract = (core: string) => toFileUrl(join(REPO, "packages", "core", core)).href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: { "@hyapi/core/contract": contract("contract.ts"), typebox: "npm:typebox@~1.3.34" },
    }),
  );
  const source = await Deno.readTextFile(join(REPO, "tests", "fixtures", "library_api.ts"));
  await Deno.writeTextFile(join(dir, "api.ts"), source);

  const out: string[] = [];
  const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) };
  const controller = new AbortController();
  const document = join(dir, "openapi.json");
  const watching = watchEmit(
    dir,
    ["--api", "./api.ts#api", "--out", "./openapi.json"],
    io,
    controller.signal,
  );
  try {
    await until(() => out.some((line) => line.startsWith("watching")));
    assertStringIncludes(await Deno.readTextFile(document), '"title": "Library API"');

    await Deno.writeTextFile(join(dir, "api.ts"), source.replace('"Library API"', '"Renamed API"'));
    // The file is written before the second emit's process exits and its output is relayed.
    const wrote = () => out.filter((line) => line.startsWith("wrote")).length;
    await until(async () =>
      wrote() >= 2 && (await Deno.readTextFile(document)).includes('"title": "Renamed API"')
    );
  } finally {
    controller.abort();
    await watching;
    await Deno.remove(dir, { recursive: true });
  }
});
