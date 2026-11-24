const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
    getPrototypeFreezeBootstrapSource,
} = require("../dist/prototype-freeze.js");
const { ECMAGlobals } = require("../dist/global/capabilities.js");
const {
    prototypeProtectionPlan,
} = require("../dist/prototype-protection.js");

function createContext() {
    return vm.createContext({});
}

test("classifies every ECMAScript global exposed by the sandbox", () => {
    assert.deepEqual(
        Object.keys(prototypeProtectionPlan.ecmaGlobals).sort(),
        [...ECMAGlobals].sort(),
    );
    assert.equal(
        prototypeProtectionPlan.ecmaGlobals.Promise,
        "freeze-prototype",
    );
    assert.equal(
        prototypeProtectionPlan.ecmaGlobals.Reflect,
        "lock-object",
    );
    assert.equal(
        prototypeProtectionPlan.ecmaGlobals.Error,
        "lock-constructor-freeze-prototype",
    );
    assert.deepEqual(prototypeProtectionPlan.compatMutableProperties.Error, [
        "stackTraceLimit",
        "prepareStackTrace",
    ]);
    assert.deepEqual(
        prototypeProtectionPlan.directLockProperties["Date.prototype"],
        ["toJSON"],
    );
    assert.equal(
        prototypeProtectionPlan.sharedTypedArrayAncestors,
        "lock-own-properties",
    );
});

test("freezes sensitive prototypes while preserving intentional extension points", () => {
    const context = createContext();
    const source = getPrototypeFreezeBootstrapSource();

    vm.runInContext(source, context);
    vm.runInContext(source, context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const object = {};
            object.of = 42;
            object.toString = function () {
                return "object-compatible";
            };
            object.hasOwnProperty = function () {
                return "own-check-compatible";
            };
            const array = [];
            array[0] = "ok";
            const cssList = [];
            cssList.toString = function () {
                return "css-loader-compatible";
            };

            class DerivedArray extends Array {}
            DerivedArray.from = function () {
                return "derived-array-from-compatible";
            };
            DerivedArray.prototype.map = function () {
                return "derived-array-map-compatible";
            };

            const regex = /warden/;
            const regexExecDescriptor = Object.getOwnPropertyDescriptor(
                RegExp.prototype,
                "exec",
            );
            const getIntrinsicStyleExec =
                regexExecDescriptor.get &&
                !("originalValue" in regexExecDescriptor.get)
                    ? regexExecDescriptor.get
                    : RegExp.prototype.exec;
            const regexMatch = getIntrinsicStyleExec.call(regex, "warden");

            async function Action() {}
            Action.call = function () {
                return "own-call-compatible";
            };
            Action.apply = function () {
                return "own-apply-compatible";
            };
            Action.bind = function () {
                return "own-bind-compatible";
            };

            function BufferLike() {}
            BufferLike.from = function () {};
            Object.setPrototypeOf(BufferLike.prototype, Uint8Array.prototype);
            Object.setPrototypeOf(BufferLike, Uint8Array);
            BufferLike.prototype.toString = function () {
                return "buffer-compatible";
            };
            BufferLike.prototype.toLocaleString = BufferLike.prototype.toString;
            BufferLike.prototype.includes = function () {};
            BufferLike.prototype.slice = function () {};
            BufferLike.of = function () {};

            Function.prototype.toString = function () {
                return "sentry-compatible";
            };
            Date.prototype.getTimeAlias = Date.prototype.getTime;
            Reflect.metadata = function () {};

            const promiseStaticNames = [
                "all",
                "race",
                "resolve",
                "reject",
                "allSettled",
                "any",
            ].filter((name) => typeof Promise[name] === "function");
            const originalPromiseStatics = Object.fromEntries(
                promiseStaticNames.map((name) => [name, Promise[name]]),
            );
            for (const name of promiseStaticNames) {
                Promise[name] = function () {
                    return "dexie-" + name + "-compatible";
                };
            }
            const promiseStaticPatchCompatible = promiseStaticNames.every(
                (name) =>
                    Promise[name]() === "dexie-" + name + "-compatible",
            );
            for (const name of promiseStaticNames) {
                Promise[name] = originalPromiseStatics[name];
            }
            const promiseStaticsRestored = promiseStaticNames.every(
                (name) => Promise[name] === originalPromiseStatics[name],
            );

            const originalPromiseThen = Promise.prototype.then;
            let promiseThenMutationBlocked = false;
            try {
                Promise.prototype.then = function () {};
            } catch {
                promiseThenMutationBlocked = true;
            }

            let arrayExtensionBlocked = false;
            try {
                Array.prototype.wardenMutation = true;
            } catch {
                arrayExtensionBlocked = true;
            }
            const originalArrayToString = Array.prototype.toString;
            let arrayToStringMutationBlocked = false;
            try {
                Array.prototype.toString = function () {};
            } catch {
                arrayToStringMutationBlocked = true;
            }

            const originalApply = Function.prototype.apply;
            let applyMutationBlocked = false;
            try {
                Function.prototype.apply = function () {};
            } catch {
                applyMutationBlocked = true;
            }

            const originalHasOwnProperty = Object.prototype.hasOwnProperty;
            let hasOwnPropertyMutationBlocked = false;
            try {
                Object.prototype.hasOwnProperty = function () {};
            } catch {
                hasOwnPropertyMutationBlocked = true;
            }

            return {
                objectPrototypeFrozen: Object.isFrozen(Object.prototype),
                objectPrototypeExtensible: Object.isExtensible(Object.prototype),
                arrayPrototypeFrozen: Object.isFrozen(Array.prototype),
                concreteTypedArrayPrototypeFrozen: Object.isFrozen(
                    Uint8Array.prototype,
                ),
                sharedTypedArrayPrototypeFrozen: Object.isFrozen(
                    Object.getPrototypeOf(Uint8Array.prototype),
                ),
                sharedTypedArrayConstructorFrozen: Object.isFrozen(
                    Object.getPrototypeOf(Uint8Array),
                ),
                promiseConstructorFrozen: Object.isFrozen(Promise),
                promisePrototypeFrozen: Object.isFrozen(Promise.prototype),
                functionPrototypeFrozen: Object.isFrozen(Function.prototype),
                datePrototypeFrozen: Object.isFrozen(Date.prototype),
                reflectFrozen: Object.isFrozen(Reflect),
                objectValue: object.of,
                objectToString: object.toString(),
                objectOwnCheck: object.hasOwnProperty(),
                arrayValue: array[0],
                cssListToString: cssList.toString(),
                cssListToStringIsOwn:
                    Object.prototype.hasOwnProperty.call(cssList, "toString"),
                derivedArrayFrom: DerivedArray.from(),
                derivedArrayMap: DerivedArray.prototype.map(),
                derivedArrayOverridesAreOwn:
                    Object.prototype.hasOwnProperty.call(DerivedArray, "from") &&
                    Object.prototype.hasOwnProperty.call(
                        DerivedArray.prototype,
                        "map",
                    ),
                regexIntrinsicMarker:
                    "originalValue" in regexExecDescriptor.get,
                regexIntrinsicExecWorks: regexMatch[0],
                actionCall: Action.call(),
                actionApply: Action.apply(),
                actionBind: Action.bind(),
                actionMethodsAreOwn:
                    Object.prototype.hasOwnProperty.call(Action, "call") &&
                    Object.prototype.hasOwnProperty.call(Action, "apply") &&
                    Object.prototype.hasOwnProperty.call(Action, "bind"),
                bufferToString: BufferLike.prototype.toString(),
                bufferHasOwnToLocaleString: Object.prototype.hasOwnProperty.call(
                    BufferLike.prototype,
                    "toLocaleString",
                ),
                bufferHasOwnIncludes: Object.prototype.hasOwnProperty.call(
                    BufferLike.prototype,
                    "includes",
                ),
                bufferHasOwnSlice: Object.prototype.hasOwnProperty.call(
                    BufferLike.prototype,
                    "slice",
                ),
                bufferHasOwnOf: Object.prototype.hasOwnProperty.call(
                    BufferLike,
                    "of",
                ),
                functionToString: (function () {}).toString(),
                dateAlias: typeof Date.prototype.getTimeAlias,
                metadata: typeof Reflect.metadata,
                promiseStaticPatchCompatible,
                promiseStaticsRestored,
                promiseThenMutationBlocked,
                promiseThenUnchanged:
                    Promise.prototype.then === originalPromiseThen,
                arrayExtensionBlocked,
                arrayWasNotExtended: !("wardenMutation" in Array.prototype),
                arrayToStringMutationBlocked,
                arrayToStringUnchanged:
                    Array.prototype.toString === originalArrayToString,
                applyMutationBlocked,
                applyUnchanged: Function.prototype.apply === originalApply,
                hasOwnPropertyMutationBlocked,
                hasOwnPropertyUnchanged:
                    Object.prototype.hasOwnProperty === originalHasOwnProperty,
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        objectPrototypeFrozen: false,
        objectPrototypeExtensible: true,
        arrayPrototypeFrozen: true,
        concreteTypedArrayPrototypeFrozen: true,
        sharedTypedArrayPrototypeFrozen: false,
        sharedTypedArrayConstructorFrozen: false,
        promiseConstructorFrozen: false,
        promisePrototypeFrozen: true,
        functionPrototypeFrozen: false,
        datePrototypeFrozen: false,
        reflectFrozen: false,
        objectValue: 42,
        objectToString: "object-compatible",
        objectOwnCheck: "own-check-compatible",
        arrayValue: "ok",
        cssListToString: "css-loader-compatible",
        cssListToStringIsOwn: true,
        derivedArrayFrom: "derived-array-from-compatible",
        derivedArrayMap: "derived-array-map-compatible",
        derivedArrayOverridesAreOwn: true,
        regexIntrinsicMarker: true,
        regexIntrinsicExecWorks: "warden",
        actionCall: "own-call-compatible",
        actionApply: "own-apply-compatible",
        actionBind: "own-bind-compatible",
        actionMethodsAreOwn: true,
        bufferToString: "buffer-compatible",
        bufferHasOwnToLocaleString: true,
        bufferHasOwnIncludes: true,
        bufferHasOwnSlice: true,
        bufferHasOwnOf: true,
        functionToString: "sentry-compatible",
        dateAlias: "function",
        metadata: "function",
        promiseStaticPatchCompatible: true,
        promiseStaticsRestored: true,
        promiseThenMutationBlocked: true,
        promiseThenUnchanged: true,
        arrayExtensionBlocked: true,
        arrayWasNotExtended: true,
        arrayToStringMutationBlocked: true,
        arrayToStringUnchanged: true,
        applyMutationBlocked: true,
        applyUnchanged: true,
        hasOwnPropertyMutationBlocked: true,
        hasOwnPropertyUnchanged: true,
    });
});

test("skips browser APIs that are not present", () => {
    const context = createContext();
    vm.runInContext(
        `delete globalThis.Crypto;
         delete globalThis.CryptoKey;
         delete globalThis.SubtleCrypto;
         delete globalThis.Float16Array;`,
        context,
    );

    assert.doesNotThrow(() =>
        vm.runInContext(getPrototypeFreezeBootstrapSource(), context),
    );
});

test("freezes optional browser constructors when they are present", () => {
    const context = createContext();
    vm.runInContext(
        `for (const name of [
             "Crypto",
             "CryptoKey",
             "SubtleCrypto",
             "TextEncoder",
             "TextDecoder",
         ]) {
             globalThis[name] = function OptionalBrowserConstructor() {};
         }`,
        context,
    );

    vm.runInContext(getPrototypeFreezeBootstrapSource(), context);

    const state = vm.runInContext(
        `Object.fromEntries([
            "Crypto",
            "CryptoKey",
            "SubtleCrypto",
            "TextEncoder",
            "TextDecoder",
        ].map((name) => [name, {
            constructor: Object.isFrozen(globalThis[name]),
            prototype: Object.isFrozen(globalThis[name].prototype),
        }]))`,
        context,
    );
    for (const name of prototypeProtectionPlan.browserConstructors) {
        assert.equal(state[name].constructor, true, name);
        assert.equal(state[name].prototype, true, `${name}.prototype`);
    }
});

test("compat mode freezes crypto.subtle methods on the singleton", () => {
    const context = createContext();
    vm.runInContext(
        `globalThis.SubtleCrypto = function SubtleCrypto() {};
         SubtleCrypto.prototype.digest = function digest() {
             return "original-digest";
         };
         SubtleCrypto.prototype.encrypt = function encrypt() {
             return "original-encrypt";
         };
         globalThis.crypto = {
             subtle: new SubtleCrypto(),
         };`,
        context,
    );

    vm.runInContext(getPrototypeFreezeBootstrapSource("compat"), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const subtle = crypto.subtle;
            const subtlePrototype = Object.getPrototypeOf(subtle);
            const originalDigest = subtle.digest;
            const originalEncrypt = subtle.encrypt;
            let digestAssignmentBlocked = false;
            let encryptDefinitionBlocked = false;
            let digestDeletionBlocked = false;
            try {
                subtle.digest = function () {};
            } catch {
                digestAssignmentBlocked = true;
            }
            try {
                Object.defineProperty(subtle, "encrypt", {
                    configurable: true,
                    value: function () {},
                    writable: true,
                });
            } catch {
                encryptDefinitionBlocked = true;
            }
            try {
                delete subtlePrototype.digest;
            } catch {
                digestDeletionBlocked = true;
            }
            return {
                subtleFrozen: Object.isFrozen(subtle),
                subtlePrototypeFrozen: Object.isFrozen(subtlePrototype),
                digestAssignmentBlocked,
                encryptDefinitionBlocked,
                digestDeletionBlocked,
                digestUnchanged: subtle.digest === originalDigest,
                encryptUnchanged: subtle.encrypt === originalEncrypt,
                digestResult: subtle.digest(),
                encryptResult: subtle.encrypt(),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        subtleFrozen: true,
        subtlePrototypeFrozen: true,
        digestAssignmentBlocked: true,
        encryptDefinitionBlocked: true,
        digestDeletionBlocked: true,
        digestUnchanged: true,
        encryptUnchanged: true,
        digestResult: "original-digest",
        encryptResult: "original-encrypt",
    });
});

test("strict mode freezes crypto.subtle methods on the singleton", () => {
    const context = createContext();
    vm.runInContext(
        `globalThis.SubtleCrypto = function SubtleCrypto() {};
         SubtleCrypto.prototype.digest = function digest() {
             return "original-digest";
         };
         globalThis.crypto = {
             subtle: new SubtleCrypto(),
         };`,
        context,
    );

    vm.runInContext(getPrototypeFreezeBootstrapSource("strict"), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const subtle = crypto.subtle;
            const originalDigest = subtle.digest;
            let digestAssignmentBlocked = false;
            try {
                subtle.digest = function () {};
            } catch {
                digestAssignmentBlocked = true;
            }
            return {
                subtleFrozen: Object.isFrozen(subtle),
                subtlePrototypeFrozen: Object.isFrozen(
                    Object.getPrototypeOf(subtle),
                ),
                digestAssignmentBlocked,
                digestUnchanged: subtle.digest === originalDigest,
                digestResult: subtle.digest(),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        subtleFrozen: true,
        subtlePrototypeFrozen: true,
        digestAssignmentBlocked: true,
        digestUnchanged: true,
        digestResult: "original-digest",
    });
});

test("locks shared typed-array methods while preserving subclass overrides", () => {
    const context = createContext();
    vm.runInContext(getPrototypeFreezeBootstrapSource(), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const sharedConstructor = Object.getPrototypeOf(Uint8Array);
            const sharedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
            const originalFrom = sharedConstructor.from;
            const originalIncludes = sharedPrototype.includes;
            let fromBlocked = false;
            let includesBlocked = false;
            try {
                sharedConstructor.from = function () {};
            } catch {
                fromBlocked = true;
            }
            try {
                sharedPrototype.includes = function () {};
            } catch {
                includesBlocked = true;
            }

            function BufferLike() {}
            Object.setPrototypeOf(BufferLike, Uint8Array);
            Object.setPrototypeOf(BufferLike.prototype, Uint8Array.prototype);
            BufferLike.from = function () { return "own-from"; };
            BufferLike.prototype.includes = function () {
                return "own-includes";
            };

            return {
                sharedConstructorFrozen: Object.isFrozen(sharedConstructor),
                sharedPrototypeFrozen: Object.isFrozen(sharedPrototype),
                fromBlocked,
                fromUnchanged: sharedConstructor.from === originalFrom,
                includesBlocked,
                includesUnchanged: sharedPrototype.includes === originalIncludes,
                derivedFrom: BufferLike.from(),
                derivedIncludes: BufferLike.prototype.includes(),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        sharedConstructorFrozen: false,
        sharedPrototypeFrozen: false,
        fromBlocked: true,
        fromUnchanged: true,
        includesBlocked: true,
        includesUnchanged: true,
        derivedFrom: "own-from",
        derivedIncludes: "own-includes",
    });
});

test("protects newly classified ECMAScript constructors and namespaces", () => {
    const context = createContext();
    vm.runInContext(getPrototypeFreezeBootstrapSource(), context);

    const state = vm.runInContext(
        `(() => {
            const constructors = [
                "AggregateError",
                "AsyncDisposableStack",
                "DisposableStack",
                "EvalError",
                "RangeError",
                "ReferenceError",
                "SyntaxError",
                "SuppressedError",
                "TypeError",
                "URIError",
                "FinalizationRegistry",
                "Iterator",
                "WeakRef",
            ].filter((name) => typeof globalThis[name] === "function");
            const intlConstructors = Object.getOwnPropertyNames(Intl)
                .filter((name) =>
                    typeof Intl[name] === "function" &&
                    Intl[name].prototype != null
                );
            return {
                constructors: constructors.every((name) =>
                    Object.isFrozen(globalThis[name]) &&
                    Object.isFrozen(globalThis[name].prototype)
                ),
                errorPrototype: Object.isFrozen(Error.prototype),
                atomics: Object.isFrozen(Atomics),
                intl: Object.isFrozen(Intl),
                intlConstructors: intlConstructors.every((name) =>
                    Object.isFrozen(Intl[name]) &&
                    Object.isFrozen(Intl[name].prototype)
                ),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        constructors: true,
        errorPrototype: true,
        atomics: true,
        intl: true,
        intlConstructors: true,
    });
});

test("compat mode preserves V8 Error hooks without reopening Error.prototype", () => {
    const context = createContext();
    const source = getPrototypeFreezeBootstrapSource("compat");
    vm.runInContext(source, context);
    vm.runInContext(
        `Error.stackTraceLimit = 50;
         Error.prepareStackTrace = function firstPrepareStackTrace() {};`,
        context,
    );

    // A service worker can encounter the bootstrap more than once. Hooks that
    // appeared after the first pass must remain explicit compatibility points.
    vm.runInContext(source, context);
    const state = vm.runInContext(
        `(() => {
            "use strict";
            Error.stackTraceLimit = 0;
            Error.prepareStackTrace = function secondPrepareStackTrace() {};
            let captureStackTraceBlocked = true;
            if (typeof Error.captureStackTrace === "function") {
                captureStackTraceBlocked = false;
                try {
                    Error.captureStackTrace = function () {};
                } catch {
                    captureStackTraceBlocked = true;
                }
            }
            return {
                errorConstructorFrozen: Object.isFrozen(Error),
                errorPrototypeFrozen: Object.isFrozen(Error.prototype),
                aggregateErrorFrozen: Object.isFrozen(AggregateError),
                stackTraceLimit: Error.stackTraceLimit,
                prepareStackTraceName: Error.prepareStackTrace.name,
                captureStackTraceBlocked,
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        errorConstructorFrozen: false,
        errorPrototypeFrozen: true,
        aggregateErrorFrozen: true,
        stackTraceLimit: 0,
        prepareStackTraceName: "secondPrepareStackTrace",
        captureStackTraceBlocked: true,
    });
});

test("compat mode locks existing Object, Function, and Date members", () => {
    const context = createContext();
    vm.runInContext(getPrototypeFreezeBootstrapSource("compat"), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const targets = [
                [Object.prototype, "toString"],
                [Function.prototype, "constructor"],
                [Date.prototype, "getTime"],
            ];
            const originals = targets.map(([owner, property]) => owner[property]);
            const blocked = targets.map(([owner, property]) => {
                try {
                    owner[property] = function () {};
                    return false;
                } catch {
                    return true;
                }
            });

            Object.prototype.wardenObjectExtension = true;
            Function.prototype.wardenFunctionExtension = true;
            Date.prototype.wardenDateExtension = true;

            return {
                objectPrototypeFrozen: Object.isFrozen(Object.prototype),
                functionPrototypeFrozen: Object.isFrozen(Function.prototype),
                datePrototypeFrozen: Object.isFrozen(Date.prototype),
                blocked: blocked.every(Boolean),
                unchanged: targets.every(
                    ([owner, property], index) => owner[property] === originals[index],
                ),
                extensionsWork:
                    Object.prototype.wardenObjectExtension === true &&
                    Function.prototype.wardenFunctionExtension === true &&
                    Date.prototype.wardenDateExtension === true,
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        objectPrototypeFrozen: false,
        functionPrototypeFrozen: false,
        datePrototypeFrozen: false,
        blocked: true,
        unchanged: true,
        extensionsWork: true,
    });
});

test("keeps Date.prototype.toJSON as an immutable data property", () => {
    const context = createContext();
    vm.runInContext(getPrototypeFreezeBootstrapSource("compat"), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const descriptor = Object.getOwnPropertyDescriptor(
                Date.prototype,
                "toJSON",
            );
            const original = Date.prototype.toJSON;
            let mutationBlocked = false;
            try {
                Date.prototype.toJSON = function () {};
            } catch {
                mutationBlocked = true;
            }
            return {
                isDataProperty: "value" in descriptor,
                hasGetter: "get" in descriptor,
                writable: descriptor.writable,
                configurable: descriptor.configurable,
                mutationBlocked,
                unchanged: Date.prototype.toJSON === original,
                serialization: JSON.stringify(new Date(0)),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        isDataProperty: true,
        hasGetter: false,
        writable: false,
        configurable: false,
        mutationBlocked: true,
        unchanged: true,
        serialization: '"1970-01-01T00:00:00.000Z"',
    });
});

test("strict mode freezes Object.prototype and removes compat exceptions", () => {
    const context = createContext();
    vm.runInContext(
        `for (const name of ["URL", "EventTarget", "Document"]) {
            globalThis[name] = function StrictBrowserConstructor() {};
        }`,
        context,
    );
    vm.runInContext(getPrototypeFreezeBootstrapSource("strict"), context);

    const state = vm.runInContext(
        `(() => {
            "use strict";
            const originalFunctionToString = Function.prototype.toString;
            let extensionBlocked = false;
            let functionToStringBlocked = false;
            let stackTraceLimitBlocked = false;
            try {
                Object.prototype.wardenStrictExtension = true;
            } catch {
                extensionBlocked = true;
            }
            try {
                Function.prototype.toString = function () {};
            } catch {
                functionToStringBlocked = true;
            }
            try {
                Error.stackTraceLimit = 50;
            } catch {
                stackTraceLimitBlocked = true;
            }
            const object = {};
            object.toString = function () { return "derived-override"; };
            return {
                objectPrototypeFrozen: Object.isFrozen(Object.prototype),
                functionPrototypeFrozen: Object.isFrozen(Function.prototype),
                datePrototypeFrozen: Object.isFrozen(Date.prototype),
                promiseConstructorFrozen: Object.isFrozen(Promise),
                sharedTypedArrayPrototypeFrozen: Object.isFrozen(
                    Object.getPrototypeOf(Uint8Array.prototype),
                ),
                arrayIteratorPrototypeFrozen: Object.isFrozen(
                    Object.getPrototypeOf([][Symbol.iterator]()),
                ),
                arrayMethodFrozen: Object.isFrozen(Array.prototype.map),
                arrayUnscopablesFrozen: Object.isFrozen(
                    Array.prototype[Symbol.unscopables],
                ),
                strictBrowserConstructorsFrozen: [
                    "URL",
                    "EventTarget",
                    "Document",
                ].every((name) =>
                    Object.isFrozen(globalThis[name]) &&
                    Object.isFrozen(globalThis[name].prototype)
                ),
                extensionBlocked,
                functionToStringBlocked,
                errorConstructorFrozen: Object.isFrozen(Error),
                stackTraceLimitBlocked,
                functionToStringUnchanged:
                    Function.prototype.toString === originalFunctionToString,
                derivedOverride: object.toString(),
                derivedOverrideIsOwn:
                    Object.prototype.hasOwnProperty.call(object, "toString"),
            };
        })()`,
        context,
    );

    assert.deepEqual({ ...state }, {
        objectPrototypeFrozen: true,
        functionPrototypeFrozen: true,
        datePrototypeFrozen: true,
        promiseConstructorFrozen: true,
        sharedTypedArrayPrototypeFrozen: true,
        arrayIteratorPrototypeFrozen: true,
        arrayMethodFrozen: true,
        arrayUnscopablesFrozen: true,
        strictBrowserConstructorsFrozen: true,
        extensionBlocked: true,
        functionToStringBlocked: true,
        errorConstructorFrozen: true,
        stackTraceLimitBlocked: true,
        functionToStringUnchanged: true,
        derivedOverride: "derived-override",
        derivedOverrideIsOwn: true,
    });
});

test("reports runtime mutation attempts separately from bootstrap failures", () => {
    const context = createContext();
    vm.runInContext(getPrototypeFreezeBootstrapSource(), context);

    assert.throws(
        () => vm.runInContext("Reflect.get = 3", context),
        (error) =>
            error?.name === "TypeError" &&
            /Modification of locked target "Reflect\.get" is not allowed/.test(
                error.message,
            ),
    );
    assert.equal(vm.runInContext("typeof Reflect.get", context), "function");
});

test("fails closed when an existing target cannot be frozen", () => {
    const context = createContext();
    vm.runInContext(
        `globalThis.Crypto = function Crypto() {};
         Crypto.prototype = new Proxy({}, {
             preventExtensions() { return false; }
         });`,
        context,
    );

    assert.throws(
        () => vm.runInContext(getPrototypeFreezeBootstrapSource(), context),
        /Failed to lock prototype target "Crypto\.prototype"/,
    );
});
