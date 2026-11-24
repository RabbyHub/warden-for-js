const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
    getWebpackRequireRuntimeSource,
} = require("../dist/webpack-require.js");

const denied = (error) => error.code === "WARDEN_WEBPACK_REQUIRE_DENIED";

function setup(attackerProperties, { protectRequire = true } = {}) {
    const rawFactory = function rawVictimFactory() {};
    const cachedModule = {
        id: "victim",
        exports: { original: true },
        loaded: true,
    };
    function realRequire(id) {
        return realRequire.c[id]?.exports;
    }
    realRequire.m = { victim: rawFactory, secret: function secretFactory() {} };
    realRequire.c = {
        victim: cachedModule,
        secret: { id: "secret", exports: { secret: true }, loaded: true },
        7: { id: 7, exports: "numeric", loaded: true },
    };
    realRequire.f = { handlers: [] };
    realRequire.i = [];
    realRequire.g = globalThis;

    const source = getWebpackRequireRuntimeSource({
        table: [
            [
                // may require package "victim" and the extra module 7
                ["attacker", {}, attackerProperties, [1], [7], ["attacker", "attacker/b"]],
                ["victim", null, [], [], [], ["victim"]],
            ],
            ["app", "secret"],
        ],
        dev: false,
        protectRequire,
    });
    vm.runInNewContext(source, { __webpack_require__: realRequire, console });
    const execute = (id) => {
        const options = { id, require: realRequire };
        realRequire.i[0](options);
        return options.require;
    };
    return {
        cachedModule,
        execute,
        protectedRequire: execute("attacker"),
        rawFactory,
        realRequire,
    };
}

test("leaves first-party modules untouched and rejects unknown modules", () => {
    const { execute, realRequire } = setup([]);
    assert.equal(execute("app"), realRequire);
    assert.throws(() => execute("unknown"), /Missing policy for webpack module unknown/);
});

test("limits requires to the package's grants", () => {
    const { execute, protectedRequire } = setup([]);
    assert.deepEqual(protectedRequire("victim"), { original: true });
    assert.equal(protectedRequire(7), "numeric");
    assert.equal(protectedRequire.call(null, "victim").original, true);
    for (const id of ["secret", "7", "missing", undefined, {}]) {
        assert.throws(
            () => protectedRequire(id),
            (error) =>
                denied(error) &&
                error.callerPackage === "attacker" &&
                error.requestedModuleId === id &&
                /Package "attacker" cannot require module/.test(error.message),
        );
    }
    // The grant is one-way: "victim" may not require "attacker".
    assert.throws(() => execute("victim")("attacker"), denied);
});

test("shares one guarded require per package", () => {
    const { execute, protectedRequire, realRequire } = setup([]);
    assert.equal(execute("attacker/b"), protectedRequire);
    assert.notEqual(execute("victim"), protectedRequire);

    // A require issued by another interceptor (HMR) is wrapped on its own.
    const hotRequire = (id) => realRequire(id);
    const options = { id: "attacker", require: hotRequire };
    realRequire.i[0](options);
    assert.notEqual(options.require, protectedRequire);
    assert.notEqual(options.require, hotRequire);
    assert.throws(() => options.require("secret"), denied);
});

test("requires explicit registry capabilities", () => {
    const { protectedRequire } = setup([]);
    for (const property of ["m", "c", "f", "i", "constructor", Symbol.iterator]) {
        assert.throws(() => protectedRequire[property], denied);
    }
    assert.throws(() => new protectedRequire(), denied);
    assert.throws(() => {
        protectedRequire.x = 1;
    }, denied);
    assert.equal(Object.getPrototypeOf(protectedRequire), null);
});

test("does not expose raw factories, module records, or mutable helper objects", () => {
    const { cachedModule, protectedRequire, rawFactory, realRequire } =
        setup(["m", "c", "f"]);

    const factoryFacade = protectedRequire.m.victim;
    assert.equal(typeof factoryFacade, "function");
    assert.notEqual(factoryFacade, rawFactory);
    assert.throws(() => factoryFacade(), denied);
    assert.equal(protectedRequire.m.secret, undefined);
    assert.deepEqual(Object.keys(protectedRequire.m), ["victim"]);

    const cacheFacade = protectedRequire.c.victim;
    assert.notEqual(cacheFacade, cachedModule);
    assert.equal(Object.isFrozen(cacheFacade), true);
    assert.equal(cacheFacade.exports, cachedModule.exports);
    assert.throws(() => {
        "use strict";
        cacheFacade.exports = { poisoned: true };
    }, TypeError);
    assert.equal(realRequire.c.victim.exports.original, true);
    assert.equal(protectedRequire.c.secret, undefined);
    assert.equal("secret" in protectedRequire.c, false);
    // Registry keys are strings; the numeric grant 7 still applies.
    assert.deepEqual(Object.keys(protectedRequire.c).sort(), ["7", "victim"]);

    assert.throws(() => {
        protectedRequire.f.injected = true;
    }, denied);
    assert.equal(realRequire.f.injected, undefined);
});

test("without require protection only the package global is replaced", () => {
    const { execute, realRequire } = setup([], { protectRequire: false });
    const sandboxed = execute("attacker");
    assert.notEqual(sandboxed, realRequire);
    assert.notEqual(sandboxed.g, globalThis);
    assert.equal(sandboxed.g, execute("attacker/b").g);
    assert.equal(sandboxed.i, undefined);
    assert.equal(sandboxed("secret").secret, true);
    // Packages without a sandbox keep the original require.
    assert.equal(execute("victim"), realRequire);
});
