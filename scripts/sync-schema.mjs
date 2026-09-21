/**
 * Copies beauta-api's schema over this one and regenerates the client.
 *
 * beauta-api owns the database and its migrations. This service reads that
 * shape and writes one table of its own rows; it never migrates. Keeping a
 * copy rather than importing across repos means the generated types here are
 * exactly the tables that exist — run this after beauta-api migrates.
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "..", "beauta-api", "prisma", "schema.prisma");
const target = join(here, "..", "prisma", "schema.prisma");

const header = `// GENERATED COPY — do not edit here.
//
// Source of truth: beauta-api/prisma/schema.prisma. Refresh with
// \`npm run prisma:sync\`, which copies it and regenerates the client.
// beauta-api owns every migration; there is deliberately no migrate script.

`;

copyFileSync(source, target);

/*
 * Migration is disabled here, not merely discouraged.
 *
 * Prisma Migrate and Introspection connect through `directUrl` when one is
 * set, while Prisma Client keeps using `url`. So directUrl is pinned to an
 * address with nothing behind it: `prisma migrate` and `prisma db push` fail
 * on connection, while queries at runtime never touch it.
 *
 * Written literally rather than through an env var, so there is nothing to
 * carry in .env, in the Dockerfile or in a secret — and nothing to forget,
 * which would take `prisma generate` down with it.
 *
 * beauta-api owns this schema. A migration run from here would change a
 * database this service does not own, from a file that is only a copy.
 */
const blocked = readFileSync(target, "utf8").replace(
  /datasource db \{[^}]*\}/,
  `datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  // Points nowhere on purpose. See above.
  directUrl = "postgresql://blocked:blocked@127.0.0.1:1/blocked"
}`,
);

writeFileSync(target, header + blocked, "utf8");
console.log(`Copied ${source} -> ${target} (migrations disabled)`);
