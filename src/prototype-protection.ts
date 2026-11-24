export type PrototypeProtectionStrategy =
    | "freeze-constructor"
    | "lock-constructor"
    | "lock-constructor-freeze-prototype"
    | "freeze-prototype"
    | "freeze-object"
    | "lock-object"
    | "freeze-constructor-namespace"
    | "immutable-value"
    | "unprotected-global-function"
    | "realm-global";

/**
 * This is the single audit manifest for ECMAScript globals exposed by the
 * sandbox and the optional browser constructors protected by the bootstrap.
 * It is serialized into the standalone runtime asset by prototype-freeze.ts.
 */
export const prototypeProtectionPlan = {
    ecmaGlobals: {
        AggregateError: "freeze-constructor",
        Array: "freeze-constructor",
        ArrayBuffer: "freeze-constructor",
        AsyncDisposableStack: "freeze-constructor",
        Atomics: "freeze-object",
        BigInt: "freeze-constructor",
        BigInt64Array: "freeze-constructor",
        BigUint64Array: "freeze-constructor",
        Boolean: "freeze-constructor",
        DataView: "freeze-constructor",
        Date: "lock-constructor",
        DisposableStack: "freeze-constructor",
        Error: "lock-constructor-freeze-prototype",
        EvalError: "freeze-constructor",
        FinalizationRegistry: "freeze-constructor",
        Float16Array: "freeze-constructor",
        Float32Array: "freeze-constructor",
        Float64Array: "freeze-constructor",
        Function: "lock-constructor",
        Infinity: "immutable-value",
        Int16Array: "freeze-constructor",
        Int32Array: "freeze-constructor",
        Int8Array: "freeze-constructor",
        Intl: "freeze-constructor-namespace",
        Iterator: "freeze-constructor",
        JSON: "freeze-object",
        Map: "freeze-constructor",
        Math: "freeze-object",
        NaN: "immutable-value",
        Number: "freeze-constructor",
        Object: "lock-constructor",
        Promise: "freeze-prototype",
        Proxy: "freeze-object",
        RangeError: "freeze-constructor",
        ReferenceError: "freeze-constructor",
        Reflect: "lock-object",
        RegExp: "freeze-constructor",
        Set: "freeze-constructor",
        SharedArrayBuffer: "freeze-constructor",
        String: "freeze-constructor",
        SuppressedError: "freeze-constructor",
        Symbol: "freeze-constructor",
        SyntaxError: "freeze-constructor",
        TypeError: "freeze-constructor",
        Uint16Array: "freeze-constructor",
        Uint32Array: "freeze-constructor",
        Uint8Array: "freeze-constructor",
        Uint8ClampedArray: "freeze-constructor",
        URIError: "freeze-constructor",
        WeakMap: "freeze-constructor",
        WeakRef: "freeze-constructor",
        WeakSet: "freeze-constructor",
        decodeURI: "unprotected-global-function",
        decodeURIComponent: "unprotected-global-function",
        encodeURI: "unprotected-global-function",
        encodeURIComponent: "unprotected-global-function",
        escape: "unprotected-global-function",
        globalThis: "realm-global",
        isFinite: "unprotected-global-function",
        isNaN: "unprotected-global-function",
        parseFloat: "unprotected-global-function",
        parseInt: "unprotected-global-function",
        undefined: "immutable-value",
        unescape: "unprotected-global-function",
    } satisfies Record<string, PrototypeProtectionStrategy>,
    browserConstructors: [
        "Crypto",
        "CryptoKey",
        "SubtleCrypto",
        "TextEncoder",
        "TextDecoder",
    ],
    compatMutableProperties: {
        // V8 tooling, Sentry and source-map support patch these hooks.
        Error: ["stackTraceLimit", "prepareStackTrace"],
        // Monitoring SDKs such as Sentry patch and restore this method.
        "Function.prototype": ["toString"],
    },
    directLockProperties: {
        // Chromium extension bindings require the native data-property shape
        // when normalizing API arguments. Converting this method to the
        // derived-override accessor used by other compatible locks causes
        // chrome.notifications options to be received as undefined.
        "Date.prototype": ["toJSON"],
    },
    frozenBrowserObjects: [["crypto", "subtle"]],
    strictFrozenPrototypes: ["Object"],
    strictFrozenConstructors: ["Object", "Function", "Date", "Promise"],
    strictBrowserConstructors: [
        "AbortController",
        "AbortSignal",
        "Blob",
        "BroadcastChannel",
        "CustomEvent",
        "DOMException",
        "Document",
        "Element",
        "Event",
        "EventTarget",
        "File",
        "FileReader",
        "FormData",
        "Headers",
        "History",
        "HTMLDocument",
        "HTMLElement",
        "Location",
        "MessageChannel",
        "MessageEvent",
        "MessagePort",
        "Navigator",
        "Node",
        "Request",
        "Response",
        "Storage",
        "URL",
        "URLSearchParams",
        "WebSocket",
        "Window",
        "Worker",
        "XMLHttpRequest",
    ],
    strictIntrinsicPrototypeChains: true,
    sharedTypedArrayAncestors: "lock-own-properties",
} as const;

export type PrototypeProtectionPlan = typeof prototypeProtectionPlan;
