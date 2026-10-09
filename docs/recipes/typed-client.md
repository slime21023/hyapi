# Typed clients

HyAPI does not ship a client. Consumers generate one from the committed `openapi.json`, in any
language. For TypeScript consumers, [openapi-typescript](https://openapi-ts.dev) and
[openapi-fetch](https://openapi-ts.dev/openapi-fetch/) work well with HyAPI's output, because every
object that crosses the wire is a named component.

## Generate types

```sh
npx openapi-typescript ./openapi.json -o ./src/api.d.ts
```

Named schemas such as `Book` become `components["schemas"]["Book"]`; each operation is keyed by its
path and method.

## Call the API

```ts
import createClient from "openapi-fetch";
import type { paths } from "./api.d.ts";

const client = createClient<paths>({ baseUrl: "https://api.example.com" });

const { data, error } = await client.GET("/books/{id}", { params: { path: { id } } });
if (error) {
  // error is the declared 404 problem body
} else {
  console.log(data.title);
}
```

## Keep clients current

Regenerate the types whenever `openapi.json` changes. `hyapi diff` on the API side tells consumers
in advance whether an update can break them.
