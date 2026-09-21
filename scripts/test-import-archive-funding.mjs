import test from "node:test";
import assert from "node:assert/strict";
import { toFundingFile } from "./import-archive-funding.mjs";

test("the archive's interval column never reaches the funding file, and rows are cleaned and ordered",()=>{
 const out=toFundingFile({symbol:"X",from:"2025-08",to:"2025-11",rows:[{time:2,rate:.2,intervalHours:8},{time:1,rate:.1,intervalHours:4},{time:1,rate:.1,intervalHours:4},{time:3,rate:NaN,intervalHours:8},{time:NaN,rate:1,intervalHours:8}]});
 assert.deepEqual(out.rows,[{time:1,rate:.1},{time:2,rate:.2}]);
 assert.ok(out.rows.every(r=>!("intervalHours" in r)),"the true interval must not be usable as a feature input");
 assert.equal(out.symbol,"X");assert.match(out.source,/interval column dropped/);
 assert.deepEqual(toFundingFile({symbol:"Y",rows:[]}).rows,[]);
});
