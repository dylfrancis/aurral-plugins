# Bundled packages

`taglib.js` is built by `pnpm build` at the root of this repo from these npm packages, unchanged. The plugin's own code in `index.js` and `lib/` is MIT.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| node-taglib-sharp | 6.0.3 | LGPL-2.1-or-later, in `LICENSE-node-taglib-sharp` | https://github.com/benrr101/node-taglib-sharp |
| iconv-lite | 0.6.3 | MIT | https://github.com/ashtuchkin/iconv-lite |
| safer-buffer | 2.1.2 | MIT | https://github.com/ChALkeR/safer-buffer |
| uuid | 8.3.2 | MIT | https://github.com/uuidjs/uuid |

To use another build of node-taglib-sharp, replace `taglib.js` with an ES module whose default export is the package's exports, or change the version in `package.json` and run `pnpm install && pnpm build`.
