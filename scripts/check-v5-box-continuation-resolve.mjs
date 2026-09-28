import { accessSync } from "node:fs";

/** Map a relative .js import onto the sibling .ts file when Node is not running
 * under tsx. Type-only packages are never rewritten. */
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    try {
      const ts = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      accessSync(ts);
      return { url: ts.href, shortCircuit: true };
    } catch {
      /* No sibling source; leave the specifier alone. */
    }
  }
  return next(specifier, context);
}
