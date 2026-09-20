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
writeFileSync(target, header + readFileSync(target, "utf8"), "utf8");
console.log(`Copied ${source} -> ${target}`);
