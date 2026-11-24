const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { parse } = require("@babel/parser");

const {
    analyzeGlobalAccess,
    getMkCompartmentSource,
    mkCompartment,
} = require("../dist/globals.js");

test("prototype pollution cannot create sandbox permissions", () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(String(message));

    try {
        Object.prototype.pollutedPermission = "rw";
        globalThis.allowedByPolicy = 7;
        globalThis.pollutedPermission = 9;

        const rules = { allowedByPolicy: "r" };
        const sandbox = mkCompartment(rules, false, "test-module");
        rules.pollutedPermission = "rw";

        assert.equal(sandbox.allowedByPolicy, 7);
        assert.equal(sandbox.pollutedPermission, undefined);
        assert.equal(Reflect.set(sandbox, "pollutedPermission", 10), false);
        assert.equal(globalThis.pollutedPermission, 9);
        assert.equal(warnings.length, 2);
        assert.match(warnings[0], /test-module/);
        assert.match(warnings[1], /test-module/);
    } finally {
        delete Object.prototype.pollutedPermission;
        delete globalThis.allowedByPolicy;
        delete globalThis.pollutedPermission;
        console.warn = originalWarn;
    }
});

test("the copied rule map is immutable from the caller", () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    globalThis.initialPermission = "initial";
    globalThis.latePermission = "late";
    try {
        const rules = { initialPermission: "r" };
        const sandbox = mkCompartment(rules, false, "test-module");
        rules.latePermission = "r";

        assert.equal(sandbox.initialPermission, "initial");
        assert.equal(sandbox.latePermission, undefined);
    } finally {
        delete globalThis.initialPermission;
        delete globalThis.latePermission;
        console.warn = originalWarn;
    }
});

test("does not return the real realm through direct global back-references", () => {
    const originalDocument = globalThis.document;
    const originalParent = globalThis.parent;
    const document = {
        defaultView: globalThis,
        getThis() {
            return this;
        },
    };
    globalThis.document = document;
    globalThis.parent = globalThis;
    try {
        const sandbox = mkCompartment(
            { document: "r", parent: "r" },
            false,
            "realm-reference-module",
        );
        assert.equal(sandbox.parent, sandbox);
        assert.equal(sandbox.document.defaultView, sandbox);
        assert.equal(sandbox.document.getThis(), document);
        assert.equal(sandbox.document, sandbox.document);
    } finally {
        if (originalDocument === undefined) {
            delete globalThis.document;
        } else {
            globalThis.document = originalDocument;
        }
        if (originalParent === undefined) {
            delete globalThis.parent;
        } else {
            globalThis.parent = originalParent;
        }
    }
});

test("reflection APIs expose only policy-authorized global properties", () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(String(message));
    const symbol = Symbol("warden-reflection");
    const originalPrototype = Object.getPrototypeOf(globalThis);

    Object.defineProperty(globalThis, "allowedDescriptor", {
        configurable: true,
        enumerable: true,
        value: "allowed",
        writable: true,
    });
    Object.defineProperty(globalThis, "allowedMutableDescriptor", {
        configurable: true,
        enumerable: true,
        value: "mutable",
        writable: true,
    });
    Object.defineProperty(globalThis, "deniedDescriptor", {
        configurable: true,
        enumerable: true,
        value: "denied",
        writable: true,
    });
    globalThis[symbol] = "symbol-value";

    try {
        const sandbox = mkCompartment(
            {
                allowedDescriptor: "r",
                allowedMutableDescriptor: "rw",
                setTimeout: "r",
            },
            false,
            "reflection-module",
        );

        const readDescriptor = Object.getOwnPropertyDescriptor(
            sandbox,
            "allowedDescriptor",
        );
        assert.equal(readDescriptor.value, "allowed");
        assert.equal(readDescriptor.writable, false);
        assert.equal(readDescriptor.configurable, true);

        const writeDescriptor = Object.getOwnPropertyDescriptor(
            sandbox,
            "allowedMutableDescriptor",
        );
        assert.equal(writeDescriptor.writable, true);
        assert.equal(
            Reflect.defineProperty(sandbox, "allowedMutableDescriptor", {
                configurable: true,
                enumerable: true,
                value: "changed",
                writable: true,
            }),
            true,
        );
        assert.equal(globalThis.allowedMutableDescriptor, "changed");

        assert.equal(
            Object.getOwnPropertyDescriptor(sandbox, "deniedDescriptor"),
            undefined,
        );
        assert.equal(Object.hasOwn(sandbox, "deniedDescriptor"), false);
        assert.equal(Reflect.has(sandbox, "deniedDescriptor"), false);
        assert.equal(Object.hasOwn(sandbox, "allowedDescriptor"), true);
        assert.equal(Reflect.has(sandbox, "allowedDescriptor"), true);
        assert.equal(Reflect.has(sandbox, "window"), true);

        const globalDescriptor = Object.getOwnPropertyDescriptor(
            sandbox,
            "globalThis",
        );
        assert.equal(globalDescriptor.value, sandbox);
        assert.equal(globalDescriptor.writable, false);

        const timeoutDescriptor = Object.getOwnPropertyDescriptor(
            sandbox,
            "setTimeout",
        );
        assert.equal(typeof timeoutDescriptor.value, "function");
        assert.notEqual(timeoutDescriptor.value, globalThis.setTimeout);

        assert.equal(
            Object.getOwnPropertyDescriptor(sandbox, symbol).value,
            "symbol-value",
        );
        const keys = Reflect.ownKeys(sandbox);
        assert.equal(keys.includes("allowedDescriptor"), true);
        assert.equal(keys.includes("deniedDescriptor"), false);
        assert.equal(keys.includes(symbol), true);

        assert.equal(Object.getPrototypeOf(sandbox), null);
        assert.equal(Reflect.setPrototypeOf(sandbox, {}), false);
        assert.equal(Reflect.preventExtensions(sandbox), false);
        assert.equal(Reflect.isExtensible(sandbox), true);
        assert.equal(Object.getPrototypeOf(globalThis), originalPrototype);
        assert.equal(Object.isExtensible(globalThis), true);
        assert.ok(warnings.length >= 5);
        assert.ok(warnings.every((warning) => /reflection-module/.test(warning)));
    } finally {
        delete globalThis.allowedDescriptor;
        delete globalThis.allowedMutableDescriptor;
        delete globalThis.deniedDescriptor;
        delete globalThis[symbol];
        console.warn = originalWarn;
    }
});

test("non-configurable denied globals fail closed without violating Proxy invariants", () => {
    const context = vm.createContext({
        console: { warn() {} },
    });
    vm.runInContext(
        `Object.defineProperty(globalThis, "lockedSecret", {
            configurable: false,
            enumerable: true,
            value: "secret",
            writable: false,
        });
        globalThis.sandbox = ${getMkCompartmentSource()}(
            {},
            false,
            "locked-module",
        );`,
        context,
    );

    assert.throws(
        () =>
            vm.runInContext(
                `Object.getOwnPropertyDescriptor(sandbox, "lockedSecret")`,
                context,
            ),
        /\[Warden\].*lockedSecret.*locked-module/,
    );
    assert.throws(
        () => vm.runInContext(`"lockedSecret" in sandbox`, context),
        /\[Warden\].*lockedSecret.*locked-module/,
    );
    assert.equal(
        vm.runInContext(
            `Reflect.ownKeys(sandbox).includes("lockedSecret")`,
            context,
        ),
        true,
    );
});

test("static reflection checks contribute read permissions", () => {
    const ast = parse(
        `"alpha" in globalThis;
         Object.hasOwn(window, "beta");
         Reflect.has(self, "gamma");
         Reflect.getOwnPropertyDescriptor(__webpack_require__.g, "delta");
         function local(Object) {
             Object.hasOwn(globalThis, "ignoredLocalObject");
         }`,
        { sourceType: "script" },
    );

    assert.deepEqual({ ...analyzeGlobalAccess(ast) }, {
        alpha: "r",
        beta: "r",
        delta: "r",
        gamma: "r",
    });
});

test("follows window aliases to the global they finally reach", () => {
    const analyze = (code) =>
        JSON.parse(JSON.stringify(analyzeGlobalAccess(parse(code))));

    assert.deepEqual(analyze(`window.top.frames.fetch("/x");`), {
        fetch: "r",
        frames: "r",
        top: "r",
    });
    assert.deepEqual(analyze(`parent.postMessage("x", "*");`), {
        parent: "r",
        postMessage: "r",
    });
    assert.deepEqual(analyze(`top.marker = 1; delete frames.other;`), {
        frames: "r",
        marker: "rw",
        other: "rw",
        top: "r",
    });
    assert.deepEqual(analyze(`if ("chrome" in top) {}`), {
        chrome: "r",
        top: "r",
    });
    // A local binding with an alias name is not the global object.
    assert.deepEqual(analyze(`const top = {}; top.fetch = 1;`), {});
});
