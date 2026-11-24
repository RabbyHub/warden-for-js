import { getMkCompartmentSource } from "./globals";
import {
    decodePolicyTable,
    policyGlobalName,
    type GlobalRules,
    type PolicyTable,
    type RuntimePackagePolicy,
    type RuntimePolicy,
} from "./policy-runtime";

export const webpackRequireDeniedCode = "WARDEN_WEBPACK_REQUIRE_DENIED";

type WebpackRequire = ((moduleId: unknown) => unknown) & Record<string, any>;
type WrapRequire = (
    realRequire: WebpackRequire,
    pkg: RuntimePackagePolicy,
    sandbox: object | undefined,
) => WebpackRequire;

// The three functions below are serialized into the Webpack runtime through
// toString(): each body must stay self-contained. Code that runs after module
// execution starts only uses primordials captured up front and indexed loops,
// so a third-party module cannot redirect it by patching shared prototypes.

/** Hands every third-party module factory its package's global and require. */
export const installModuleGuard = (
    webpackRequire: WebpackRequire,
    policy: RuntimePolicy,
    makeCompartment: (
        rules: GlobalRules,
        dev: boolean,
        owner: string,
    ) => object,
    dev: boolean,
    wrapRequire: WrapRequire,
) => {
    const errorCtor = Error;
    const stringCtor = String;
    const lookup = policy.lookup;
    // Indexed by package: one sandbox and one wrapped require per package.
    const sandboxes: Record<number, object> = Object.create(null);
    const requires: Record<number, WebpackRequire> = Object.create(null);
    const interceptors = webpackRequire.i;

    interceptors[interceptors.length] = (options: {
        id: unknown;
        require: WebpackRequire;
    }) => {
        const pkg = lookup(options.id);
        if (pkg === undefined) {
            throw new errorCtor(
                `[Warden] Missing policy for webpack module ${stringCtor(options.id)}`,
            );
        }
        if (pkg === null) {
            return; // first-party module: left untouched
        }
        let sandbox: object | undefined;
        if (pkg.rules !== null) {
            sandbox = sandboxes[pkg.index];
            if (sandbox === undefined) {
                sandbox = makeCompartment(pkg.rules, dev, pkg.name);
                sandboxes[pkg.index] = sandbox;
            }
        }
        if (options.require !== webpackRequire) {
            // Another interceptor (HMR) already issued a per-module require.
            options.require = wrapRequire(options.require, pkg, sandbox);
            return;
        }
        let wrapped = requires[pkg.index];
        if (wrapped === undefined) {
            wrapped = wrapRequire(webpackRequire, pkg, sandbox);
            requires[pkg.index] = wrapped;
        }
        options.require = wrapped;
    };
};

/** Only swaps `__webpack_require__.g` for the package sandbox. */
export const createGlobalRequire = (): WrapRequire => {
    const freeze = Object.freeze;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const proxyCtor = Proxy;
    const reflectDefineProperty = Reflect.defineProperty;
    const reflectDeleteProperty = Reflect.deleteProperty;
    const reflectGet = Reflect.get;
    const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
    const reflectSet = Reflect.set;
    const isPrivate = (property: PropertyKey) =>
        property === "g" || property === "i";

    return (realRequire, _pkg, sandbox) => {
        if (sandbox === undefined) {
            return realRequire;
        }
        if (getOwnPropertyDescriptor(realRequire, "g")?.configurable === false) {
            throw new Error(
                "[Warden] Webpack require global capability is not configurable",
            );
        }
        return new proxyCtor(
            realRequire,
            freeze({
                defineProperty: (target, property, descriptor) =>
                    !isPrivate(property) &&
                    reflectDefineProperty(target, property, descriptor),
                deleteProperty: (target, property) =>
                    !isPrivate(property) &&
                    reflectDeleteProperty(target, property),
                get: (target, property, receiver) =>
                    property === "g"
                        ? sandbox
                        : property === "i"
                          ? undefined
                          : reflectGet(target, property, receiver),
                getOwnPropertyDescriptor: (target, property) =>
                    property === "g"
                        ? {
                              configurable: true,
                              enumerable: true,
                              value: sandbox,
                              writable: false,
                          }
                        : property === "i"
                          ? undefined
                          : reflectGetOwnPropertyDescriptor(target, property),
                set: (target, property, value, receiver) =>
                    !isPrivate(property) &&
                    reflectSet(target, property, value, receiver),
            } satisfies ProxyHandler<WebpackRequire>),
        );
    };
};

/** Restricts which modules and webpack helpers a package can reach. */
export const createProtectedRequire = (
    policy: RuntimePolicy,
    deniedCode: string,
): WrapRequire => {
    const globalObject = globalThis;
    const errorCtor = Error;
    const proxyCtor = Proxy;
    const stringCtor = String;
    const weakMapCtor = WeakMap;
    const create = Object.create;
    const defineProperty = Object.defineProperty;
    const freeze = Object.freeze;
    const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const reflectApply = Reflect.apply;
    const reflectGet = Reflect.get;
    const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
    const reflectHas = Reflect.has;
    const reflectOwnKeys = Reflect.ownKeys;
    const functionCall = Function.prototype.call;
    const functionApply = Function.prototype.apply;
    const functionBind = Function.prototype.bind;
    const weakMapGet = WeakMap.prototype.get;
    const weakMapSet = WeakMap.prototype.set;
    const lookup = policy.lookup;
    const allows = policy.allows;
    const reject = () => false;
    const nullPrototype = () => null;

    const deny = (
        pkg: RuntimePackagePolicy,
        capability: string | null,
        requestedId?: unknown,
    ): never => {
        let message = `Package "${pkg.name}" cannot `;
        if (capability === null) {
            const owner = lookup(requestedId);
            message += `require module "${stringCtor(requestedId)}"`;
            if (owner != null) {
                message += ` of package "${owner.name}"`;
            }
        } else {
            message += `access webpack require capability "${capability}"`;
        }
        const error = new errorCtor(`[Warden] ${message}`);
        const define = (key: string, value: unknown) =>
            defineProperty(error, key, {
                configurable: false,
                enumerable: true,
                value,
                writable: false,
            });
        define("code", deniedCode);
        define("callerPackage", pkg.name);
        define("requestedModuleId", requestedId);
        throw error;
    };

    // `__webpack_require__.m` / `.c` keys are always strings, ids may be numbers.
    const registryAllows = (pkg: RuntimePackagePolicy, key: PropertyKey) =>
        typeof key === "string" &&
        (allows(pkg, key) || (stringCtor(+key) === key && allows(pkg, +key)));

    /** Read-only view of a module registry limited to requirable modules. */
    const makeRegistryView = (
        source: Record<string, unknown>,
        pkg: RuntimePackagePolicy,
        facade: (value: unknown, key: string) => unknown,
    ) => {
        const visible = (key: PropertyKey): key is string =>
            registryAllows(pkg, key) &&
            getOwnPropertyDescriptor(source, key) != null;
        return new proxyCtor(
            create(null),
            freeze({
                defineProperty: reject,
                deleteProperty: reject,
                get: (_target, key) =>
                    visible(key) ? facade(source[key], key) : undefined,
                getOwnPropertyDescriptor: (_target, key) =>
                    visible(key)
                        ? {
                              configurable: true,
                              enumerable: true,
                              value: facade(source[key], key),
                              writable: false,
                          }
                        : undefined,
                getPrototypeOf: nullPrototype,
                has: (_target, key) => visible(key),
                ownKeys: () => {
                    const sourceKeys = reflectOwnKeys(source);
                    const result: string[] = [];
                    for (let index = 0; index < sourceKeys.length; index += 1) {
                        const key = sourceKeys[index]!;
                        if (visible(key)) {
                            result[result.length] = key;
                        }
                    }
                    return result;
                },
                preventExtensions: reject,
                set: reject,
                setPrototypeOf: reject,
            } satisfies ProxyHandler<object>),
        );
    };

    /** Runtime helpers stay callable/readable but can never be mutated. */
    const makeHelperView = (
        helper: unknown,
        pkg: RuntimePackagePolicy,
        capability: string,
    ) => {
        if (typeof helper === "function") {
            return freeze(function (this: unknown) {
                return reflectApply(helper, this, arguments);
            });
        }
        if (typeof helper !== "object" || helper === null) {
            return helper;
        }
        const views = new weakMapCtor<object, object>();
        const wrap = (value: unknown, path: string): unknown => {
            if (typeof value !== "object" || value === null) {
                return value;
            }
            const existing = reflectApply(weakMapGet, views, [value]);
            if (existing !== undefined) {
                return existing;
            }
            const denyProperty = (_target: object, key: PropertyKey) =>
                deny(pkg, `${path}.${stringCtor(key)}`);
            const read = (key: PropertyKey) => {
                const nested = reflectGet(value, key, value);
                return typeof nested === "function"
                    ? freeze(() => denyProperty(value, key))
                    : wrap(nested, `${path}.${stringCtor(key)}`);
            };
            const view = new proxyCtor(
                create(null),
                freeze({
                    defineProperty: denyProperty,
                    deleteProperty: denyProperty,
                    get: (_target, key) => read(key),
                    getOwnPropertyDescriptor: (_target, key) => {
                        const descriptor = reflectGetOwnPropertyDescriptor(
                            value,
                            key,
                        );
                        return descriptor == null
                            ? undefined
                            : {
                                  configurable: true,
                                  enumerable: descriptor.enumerable === true,
                                  value: read(key),
                                  writable: false,
                              };
                    },
                    getPrototypeOf: nullPrototype,
                    has: (_target, key) => reflectHas(value, key),
                    ownKeys: () => reflectOwnKeys(value),
                    preventExtensions: reject,
                    set: denyProperty,
                    setPrototypeOf: reject,
                } satisfies ProxyHandler<object>),
            );
            reflectApply(weakMapSet, views, [value, view]);
            return view;
        };
        return wrap(helper, capability);
    };

    const factoryFacade = (pkg: RuntimePackagePolicy) => (
        value: unknown,
        key: string,
    ) =>
        value == null ? value : freeze(() => deny(pkg, `m.${key}`));
    const cacheFacade = (value: any) => {
        if (value == null) {
            return value;
        }
        if (typeof value !== "object" && typeof value !== "function") {
            return undefined;
        }
        const facade = create(null);
        const fields = ["id", "loaded", "exports"];
        for (let index = 0; index < fields.length; index += 1) {
            const field = fields[index]!;
            if (getOwnPropertyDescriptor(value, field) != null) {
                facade[field] = value[field];
            }
        }
        return freeze(facade);
    };

    return (realRequire, pkg, sandbox) => {
        const helpers: Record<string, unknown> = create(null);
        const hasProperty = (property: PropertyKey): property is string =>
            typeof property === "string" &&
            property !== "i" &&
            pkg.properties[property] === true;
        const assertAllowed = (requestedId: unknown) => {
            if (!allows(pkg, requestedId)) {
                deny(pkg, null, requestedId);
            }
        };
        const denyProperty = (_target: unknown, property: PropertyKey) =>
            deny(pkg, stringCtor(property));
        let protectedRequire: WebpackRequire;

        const makeHelper = (property: string) => {
            const helper = realRequire[property];
            if (property === "m" || property === "c") {
                return helper == null
                    ? undefined
                    : makeRegistryView(
                          helper,
                          pkg,
                          property === "m" ? factoryFacade(pkg) : cacheFacade,
                      );
            }
            // Helpers that load a module by id re-check the requested id.
            if (property === "t" || property === "z" || property === "zO") {
                return freeze(function (value: unknown, mode: number) {
                    if (property !== "t" || mode & 1) {
                        assertAllowed(value);
                    }
                    return reflectApply(helper, protectedRequire, arguments);
                });
            }
            return makeHelperView(helper, pkg, property);
        };

        protectedRequire = new proxyCtor<WebpackRequire>(
            reflectApply(functionBind, realRequire, [null]),
            freeze({
                apply: (_target, _thisArg, args) => {
                    assertAllowed(args[0]);
                    return reflectApply(realRequire, realRequire, args);
                },
                construct: () => deny(pkg, "construct"),
                defineProperty: denyProperty,
                deleteProperty: denyProperty,
                get: (_target, property) => {
                    if (property === "g") {
                        return sandbox !== undefined
                            ? sandbox
                            : realRequire.g == null
                              ? globalObject
                              : realRequire.g;
                    }
                    if (property === "call") return functionCall;
                    if (property === "apply") return functionApply;
                    if (property === "bind") return functionBind;
                    if (property === "name" || property === "length") {
                        return realRequire[property];
                    }
                    if (!hasProperty(property)) {
                        return denyProperty(null, property);
                    }
                    if (!(property in helpers)) {
                        helpers[property] = makeHelper(property);
                    }
                    return helpers[property];
                },
                getOwnPropertyDescriptor: (target, property) => {
                    const own = getOwnPropertyDescriptor(target, property);
                    if (own != null && own.configurable === false) {
                        return own;
                    }
                    return property === "g" ||
                        property === "call" ||
                        property === "apply" ||
                        property === "bind" ||
                        hasProperty(property)
                        ? {
                              configurable: true,
                              enumerable: true,
                              value: protectedRequire[property],
                              writable: false,
                          }
                        : undefined;
                },
                getPrototypeOf: nullPrototype,
                preventExtensions: reject,
                set: denyProperty,
                setPrototypeOf: reject,
            } satisfies ProxyHandler<WebpackRequire>),
        );
        return protectedRequire;
    };
};

export type RequireRuntimeOptions = {
    /** Inline policy; omit to read the shared policy runtime global. */
    table?: PolicyTable;
    dev: boolean;
    protectRequire: boolean;
};

/** Source of the runtime module added to every Webpack runtime chunk. */
export function getWebpackRequireRuntimeSource({
    table,
    dev,
    protectRequire,
}: RequireRuntimeOptions) {
    const policy =
        table == null
            ? `globalThis[${JSON.stringify(policyGlobalName)}]`
            : `(${decodePolicyTable.toString()})(${JSON.stringify(table)})`;
    const wrapRequire = protectRequire
        ? `(${createProtectedRequire.toString()})(policy, ${JSON.stringify(webpackRequireDeniedCode)})`
        : `(${createGlobalRequire.toString()})()`;
    return `/* warden-webpack-require */
;(() => {
    "use strict";
    const policy = ${policy};
    if (policy == null) {
        throw new Error("[Warden] Missing webpack require policy runtime");
    }
    (${installModuleGuard.toString()})(
        __webpack_require__,
        policy,
        ${getMkCompartmentSource()},
        ${JSON.stringify(dev)},
        ${wrapRequire},
    );
})();
`;
}
