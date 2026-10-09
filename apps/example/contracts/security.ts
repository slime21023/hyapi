import { defineSecurity, httpBearer } from "@hyapi/core/contract";

/** The identity that the bearer verifier produces for handlers. */
export interface Librarian {
  readonly subject: string;
}

export const security = defineSecurity({
  bearer: httpBearer<Librarian>({
    bearerFormat: "JWT",
    description: "A librarian's access token.",
  }),
});
