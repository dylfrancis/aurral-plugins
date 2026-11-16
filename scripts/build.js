// Bundles the npm packages plugins use into their vendor folders, because Aurral installs none.
// node-taglib-sharp is LGPL, so it stays a file of its own that anyone can rebuild or replace.
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vendor = path.join(root, "metadata/vendor");
const taglib = path.join(root, "node_modules/node-taglib-sharp");
const { version } = JSON.parse(await readFile(path.join(taglib, "package.json"), "utf8"));

await build({
  stdin: {
    contents: 'import * as taglib from "node-taglib-sharp";\nexport default taglib;\n',
    resolveDir: root,
    sourcefile: "taglib.js",
  },
  outfile: path.join(vendor, "taglib.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  minify: true,
  banner: {
    js: [
      `// node-taglib-sharp ${version} and its dependencies, bundled by \`pnpm build\`.`,
      "// Licenses are in NOTICE.md beside this file. Don't edit this file by hand.",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "warning",
});
await copyFile(path.join(taglib, "LICENSE"), path.join(vendor, "LICENSE-node-taglib-sharp"));
