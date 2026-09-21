// Runtime gate: the .mjs scripts import lib/*.ts directly, which needs type stripping ON by default (Node 22.18+, or 23.6+). Older Node does not fail
// with a version message but with a syntax error inside lib/*.ts, which looks like a code bug. Import this module FIRST (ES imports run in order).
export function nodeVersionOk(version) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return (major === 22 && minor >= 18) || (major === 23 && minor >= 6) || major >= 24;
}

export function versionMessage(version) {
  return `需要 Node ≥22.18（或 ≥23.6），当前 ${version}。\n原因：本项目的 .mjs 脚本直接 import lib/*.ts，依赖类型剥离默认开启。请升级 Node 后重试。`;
}

if (!nodeVersionOk(process.version)) {
  console.error(versionMessage(process.version));
  process.exit(1);
}
