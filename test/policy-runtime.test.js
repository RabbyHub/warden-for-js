const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const { getPolicyRuntimeSource } = require("../dist/policy-runtime.js");

// [name, global rules, helpers, allowed packages, allowed modules, own modules]
const table = [
    [
        ["a", { fetch: "r" }, ["d", "r"], [1], ["./shared"], [1, 2]],
        ["a > b", null, [], [], [], [3, "three"]],
        ["c", {}, [], [], [], [4]],
    ],
    [0, "./shared"],
];

function load(policyTable) {
    const context = vm.createContext({});
    vm.runInContext(getPolicyRuntimeSource(policyTable), context);
    return context;
}

test("resolves module owners and package-level require grants", () => {
    const context = load(table);
    const result = vm.runInContext(
        `(() => {
            const a = __wardenPolicy.lookup(1);
            const nested = __wardenPolicy.lookup("three");
            return {
                names: [a.name, __wardenPolicy.lookup(2).name, nested.name],
                samePackage: a === __wardenPolicy.lookup(2),
                firstParty: __wardenPolicy.lookup(0),
                unknown: __wardenPolicy.lookup(99),
                stringOfNumericId: __wardenPolicy.lookup("1"),
                rules: { ...a.rules },
                disabledRules: nested.rules,
                ownModule: __wardenPolicy.allows(a, 2),
                allowedPackage: __wardenPolicy.allows(a, 3),
                allowedModule: __wardenPolicy.allows(a, "./shared"),
                otherFirstParty: __wardenPolicy.allows(a, 0),
                otherPackage: __wardenPolicy.allows(a, 4),
                reverse: __wardenPolicy.allows(nested, 1),
                invalidId: __wardenPolicy.allows(a, { toString: () => "2" }),
            };
        })()`,
        context,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        names: ["a", "a", "a > b"],
        samePackage: true,
        firstParty: null,
        rules: { fetch: "r" },
        disabledRules: null,
        ownModule: true,
        allowedPackage: true,
        allowedModule: true,
        otherFirstParty: false,
        otherPackage: false,
        reverse: false,
        invalidId: false,
    });
    assert.equal(result.unknown, undefined);
    assert.equal(result.stringOfNumericId, undefined);
});

test("installs an immutable policy global", () => {
    const context = load(table);
    const state = vm.runInContext(
        `(() => {
            const descriptor = Object.getOwnPropertyDescriptor(
                globalThis,
                "__wardenPolicy",
            );
            const pkg = __wardenPolicy.lookup(1);
            return {
                configurable: descriptor.configurable,
                writable: descriptor.writable,
                frozen: [
                    __wardenPolicy,
                    __wardenPolicy.lookup,
                    pkg,
                    pkg.rules,
                    pkg.properties,
                    pkg.packages,
                    pkg.modules,
                ].every(Object.isFrozen),
                rulesPrototype: Object.getPrototypeOf(pkg.rules),
            };
        })()`,
        context,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(state)), {
        configurable: false,
        writable: false,
        frozen: true,
        rulesPrototype: null,
    });
    assert.throws(
        () => vm.runInContext(getPolicyRuntimeSource(table), context),
        /already exists/,
    );
});

test("rejects malformed policy tables", () => {
    const invalid = [
        [[[["a", { fetch: "x" }, [], [], [], [1]]], []], /Invalid policy mode/],
        [[[["a", {}, [], [], [], [1]]], [1]], /duplicate webpack module id/],
        [[[["a", {}, [], [5], [], [1]]], []], /Invalid or duplicate policy value/],
        [[[["", {}, [], [], [], [1]]], []], /Invalid package name/],
        [[[["a", {}, [], [], [], [1.5]]], []], /Invalid or duplicate webpack module id/],
    ];
    for (const [policyTable, expected] of invalid) {
        assert.throws(() => load(policyTable), expected);
    }
});

test("keeps large package tables compact", () => {
    const ownModules = Array.from({ length: 2000 }, (_, id) => id + 1);
    const source = getPolicyRuntimeSource([
        [["shared-package", { setTimeout: "r" }, ["d"], [], [], ownModules]],
        [0],
    ]);
    assert.ok(source.length < 20_000, `unexpected size: ${source.length}`);
    assert.equal(source.split("shared-package").length - 1, 1);
});
