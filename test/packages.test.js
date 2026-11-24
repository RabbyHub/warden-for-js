const assert = require("node:assert/strict");
const test = require("node:test");

const { getPackageName } = require("../dist/plugin/packages.js");

test("names packages by their node_modules nesting", () => {
    const cases = {
        "/app/node_modules/a/index.js": "a",
        "/app/node_modules/@scope/a/lib/x.js": "@scope/a",
        "/app/node_modules/a/node_modules/b/index.js": "a > b",
        "/app/node_modules/a/node_modules/@scope/b/node_modules/c/x.js":
            "a > @scope/b > c",
        "C:\\app\\node_modules\\a\\node_modules\\b\\index.js": "a > b",
        // pnpm keeps real packages below a dot-prefixed store directory.
        "/app/node_modules/.pnpm/a@1.0.0/node_modules/a/index.js": "a",
        // A directory merely named like a package is not a nesting level.
        "/app/node_modules/a/lib/node_modules.js": "a",
    };
    for (const [file, expected] of Object.entries(cases)) {
        assert.equal(getPackageName(file), expected, file);
    }
});

test("treats files outside node_modules as first-party", () => {
    assert.equal(getPackageName("/app/src/index.ts"), null);
    assert.equal(getPackageName("/app/node_modules/.cache/x.js"), null);
});
