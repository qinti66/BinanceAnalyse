import assert from "node:assert/strict";
import { nodeVersionOk, versionMessage } from "./require-node.mjs";
for (const v of ["v22.18.0", "v22.20.1", "v23.6.0", "v23.11.0", "v24.0.0", "v25.1.0"]) assert.equal(nodeVersionOk(v), true, v);
for (const v of ["v22.13.0", "v22.15.0", "v22.17.9", "v23.0.0", "v23.5.0", "v20.19.0", "v18.0.0"]) assert.equal(nodeVersionOk(v), false, v);
assert.match(versionMessage("v22.15.0"), /≥22\.18.*v22\.15\.0/s);
console.log("require-node tests ok");
