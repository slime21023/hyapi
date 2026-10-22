import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packPackage, readPackages} from './packages.ts';
import {runProcess} from './process.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

const temp = await mkdtemp(join(tmpdir(), 'hyapi-consumer-'));
try {
  const [pkg] = await readPackages();
  if (!pkg) throw new Error('hyapi package is missing.');
  const archive = await packPackage(pkg, temp);
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        hyapi: `file:${archive}`,
        '@inferdi/inferdi': '6.1.0',
        valibot: '1.5.0',
      },
    }),
  );
  await writeFile(
    join(temp, 'consumer.mjs'),
    `
import assert from "node:assert/strict";
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, UnauthorizedError } from "hyapi";

let created = 0;
const disposed = [];
class Session {
  constructor(subject, sequence) {
    this.subject = subject;
    this.sequence = sequence;
  }
  dispose() { disposed.push(this.sequence); }
}
const root = new Container()
  .declareScopeInputs()
  .registerValue("answer", { value: 42 })
  .registerFactory(
    "session",
    (scope) => new Session(scope.get("identity").subject, ++created),
    ["identity"],
    "scoped",
  );
let app;
try {
  app = createApp({
    container: root,
    openapi: {
      path: "/docs",
      info: { title: "Packed consumer", version: "1.0.0" },
      securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
    },
    modules: ({ module }) => [
      module({
        name: "probe",
        prefix: "/probe",
        routes: (route) => [
          route.get("/", {
            response: v.object({ answer: v.number() }),
            handler: ({ root }) => ({ answer: root.get("answer").value }),
          }),
        ],
      }),
      module({
        name: "private",
        prefix: "/private",
        security: "BearerAuth",
        authenticate(request) {
          const authorization = request.headers.get("authorization");
          if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
          return { subject: authorization.slice(7) };
        },
        routes: (route) => [
          route.post("/echo", {
            body: v.object({ message: v.string() }),
            response: v.object({
              subject: v.string(),
              message: v.string(),
              sequence: v.number(),
            }),
            scoped: true,
            handler: ({ body, identity, scope }) => {
              const session = scope.get("session");
              assert.equal(session.subject, identity.subject);
              return { subject: session.subject, message: body.message, sequence: session.sequence };
            },
          }),
        ],
      }),
    ],
  });

  const listener = await app.listen({ port: 0, hostname: "127.0.0.1" });
  const endpoint = (path) => new URL(path, listener.url);
  const probe = await fetch(endpoint("/probe/"));
  assert.equal(probe.status, 200);
  assert.deepEqual(await probe.json(), { answer: 42 });

  const unauthorized = await fetch(endpoint("/private/echo"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{malformed",
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(created, 0);

  const malformed = await fetch(endpoint("/private/echo"), {
    method: "POST",
    headers: { authorization: "Bearer alice", "content-type": "application/json" },
    body: "{malformed",
  });
  assert.equal(malformed.status, 400);
  assert.equal(created, 0);

  for (const [subject, sequence] of [["alice", 1], ["bob", 2]]) {
    const response = await fetch(endpoint("/private/echo"), {
      method: "POST",
      headers: { authorization: "Bearer " + subject, "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { subject, message: "hello", sequence });
    assert.deepEqual(disposed, Array.from({ length: sequence }, (_, index) => index + 1));
  }
  assert.equal(created, 2);

  const docs = await fetch(endpoint("/docs/json"));
  assert.equal(docs.status, 200);
  const document = await docs.json();
  assert.equal(document.info.title, "Packed consumer");
  assert.ok(document.paths["/probe/"]);
  assert.ok(document.paths["/private/echo"]);
  assert.deepEqual(document.paths["/private/echo"].post.security, [{ BearerAuth: [] }]);
} finally {
  try {
    await app?.close({ timeoutMs: 5000 });
  } finally {
    await root.dispose();
  }
}
assert.equal(root.disposed, true);
console.log("Packed hyapi consumer passed");
`,
  );
  await writeFile(
    join(temp, 'consumer.ts'),
    `
import { Container } from "@inferdi/inferdi";
import * as v from "valibot";
import { createApp, UnauthorizedError } from "hyapi";

interface Identity { readonly subject: string }
let created = 0;
const disposed: number[] = [];
class Session {
  constructor(readonly subject: string, readonly sequence: number) {}
  dispose(): void { disposed.push(this.sequence); }
}
const root = new Container()
  .declareScopeInputs<{ identity: Identity; tenant: { id: string } }>()
  .registerValue("answer", { value: 42 })
  .registerFactory(
    "session",
    (scope) => new Session(scope.get("identity").subject, ++created),
    ["identity"],
    "scoped",
  )
  .registerFactory("tenantSession", (scope) => scope.get("tenant").id, ["tenant"], "scoped");
const answer: { readonly value: number } = root.get("answer");
const scope = root.createScope({ identity: { subject: "alice" } });
const session: Session = scope.get("session");
void answer;
void session;
// @ts-expect-error Unknown keys are not part of the root graph.
root.get("missing");
// @ts-expect-error Unknown keys are not part of the scoped graph.
scope.get("missing");
// @ts-expect-error A tenant service is not ready until the tenant input is supplied.
scope.get("tenantSession");

export const app = createApp({
  container: root,
  openapi: {
    path: "/docs",
    info: { title: "Packed consumer", version: "1.0.0" },
    securitySchemes: { BearerAuth: { type: "http", scheme: "bearer" } },
  },
  modules: ({ module }) => [
    module({
      name: "probe",
      prefix: "/probe",
      routes: (route) => [
        route.get("/", {
          response: v.object({ answer: v.number() }),
          handler: ({ root }) => {
            const service: { readonly value: number } = root.get("answer");
            return { answer: service.value };
          },
        }),
      ],
    }),
    module({
      name: "private",
      prefix: "/private",
      security: "BearerAuth",
      authenticate(request) {
        const authorization = request.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) throw new UnauthorizedError();
        return { subject: authorization.slice(7) };
      },
      routes: (route) => [
        route.post("/echo", {
          body: v.object({ message: v.string() }),
          response: v.object({ subject: v.string(), message: v.string(), sequence: v.number() }),
          scoped: true,
          handler: ({ body, identity, scope }) => {
            const service: Session = scope.get("session");
            // @ts-expect-error Identity alone cannot satisfy the missing tenant input.
            scope.get("tenantSession");
            if (service.subject !== identity.subject) throw new Error("Scope identity mismatch");
            return { subject: service.subject, message: body.message, sequence: service.sequence };
          },
        }),
      ],
    }),
  ],
});

export const shutdown = (): Promise<void> => app.close({ timeoutMs: 1000 });
// @ts-expect-error The close timeout is a number of milliseconds.
void app.close({ timeoutMs: "1000" });
`,
  );
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      extends: join(root, 'tsconfig.base.json'),
      compilerOptions: {
        noEmit: true,
        typeRoots: [join(root, 'node_modules', '@types')],
      },
      include: ['consumer.ts'],
    }),
  );
  await runProcess('bun', ['install'], temp);
  // Walk only declarations reachable from the facade; private Core files may still use Elysia.
  const dist = join(temp, 'node_modules', 'hyapi', 'dist');
  const pending = [join(dist, 'mod.d.ts')];
  const visited = new Set<string>();
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, 'utf8');
    for (const [, specifier] of source.matchAll(
      /(?:from|import\()\s*["']([^"']+)["']/g,
    )) {
      if (/^(?:elysia|@elysia\/)/.test(specifier!)) {
        throw new Error(
          `Public declarations expose Elysia through ${file}: ${specifier}`,
        );
      }
      if (specifier!.startsWith('.')) {
        pending.push(
          join(dirname(file), specifier!.replace(/\.[cm]?[jt]s$/, '.d.ts')),
        );
      }
    }
  }
  if (visited.size < 2) {
    throw new Error('Public declaration graph was not traversed.');
  }
  await runProcess(
    'node',
    [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', temp],
    temp,
  );
  await runProcess('bun', ['consumer.mjs'], temp);
  await runProcess('node', ['consumer.mjs'], temp);
} finally {
  await rm(temp, {recursive: true, force: true});
}
