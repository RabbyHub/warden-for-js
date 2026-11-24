import { ECMAGlobals, globalFuncs } from "./capabilities";
import type { RuntimeGlobalAccessMode } from "./types";

// Serialized into the Webpack runtime through toString(): the body must stay
// self-contained, so the capability lists arrive as arguments.
export const mkCompartmentFactory = (
    ecmaGlobals: readonly string[],
    hostFunctions: readonly string[],
) => {
    const objectCreate = Object.create;
    const objectFreeze = Object.freeze;
    objectFreeze(ecmaGlobals);
    objectFreeze(hostFunctions);
    const objectKeys = Object.keys;
    const hasOwnProperty = Object.prototype.hasOwnProperty;
    const arrayIncludes = Array.prototype.includes;
    const functionBind = Function.prototype.bind;
    const reflectApply = Reflect.apply;
    const reflectDefineProperty = Reflect.defineProperty;
    const reflectDeleteProperty = Reflect.deleteProperty;
    const reflectGet = Reflect.get;
    const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor;
    const reflectGetPrototypeOf = Reflect.getPrototypeOf;
    const reflectHas = Reflect.has;
    const reflectIsExtensible = Reflect.isExtensible;
    const reflectOwnKeys = Reflect.ownKeys;
    const reflectSet = Reflect.set;
    const proxyCtor = Proxy;
    const stringCtor = String;
    const typeErrorCtor = TypeError;
    const weakMapCtor = WeakMap;

    return (
        rules: Record<string, RuntimeGlobalAccessMode>,
        dev: boolean = false,
        owner: string = "",
    ) => {
        const og = globalThis;
        const safeRules: Record<string, RuntimeGlobalAccessMode> = objectCreate(null);
        for (const key of objectKeys(rules)) {
            safeRules[key] = rules[key]!;
        }
        objectFreeze(safeRules);

        const hasOwnRule = (prop: PropertyKey) =>
            typeof prop === "string" &&
            reflectApply(hasOwnProperty, safeRules, [prop]);
        const getRule = (prop: PropertyKey) =>
            hasOwnRule(prop) ? safeRules[prop as string] : undefined;
        const includes = (items: readonly PropertyKey[], value: PropertyKey) =>
            typeof value === "string" &&
            reflectApply(arrayIncludes, items, [value]);
        const bindToGlobal = (value: Function) =>
            reflectApply(functionBind, value, [og]);
        let realmCarrierCache: WeakMap<object, object> | undefined;
        let boundHostFunctionCache: WeakMap<Function, Function> | undefined;
        const deniedForOwner = owner ? ` in package "${owner}"` : "";

        const isGlobalAlias = (prop: PropertyKey) =>
            prop === "globalThis" || prop === "self" || prop === "window";
        const isReadAllowed = (prop: PropertyKey) => {
            const rule = getRule(prop);
            return rule !== "deny" && (
                typeof prop === "symbol" ||
                isGlobalAlias(prop) ||
                rule != null ||
                includes(ecmaGlobals, prop)
            );
        };
        const canDiscover = (prop: PropertyKey) => dev && getRule(prop) !== "deny";
        const recordDevAccess = (
            prop: PropertyKey,
            mode: "r" | "rw",
        ) => {
            if (typeof prop !== "string") {
                return;
            }
            //@ts-expect-error
            og.__dbg_ru1n = og.__dbg_ru1n || objectCreate(null);
            //@ts-expect-error
            og.__dbg_ru1n[owner] =
                //@ts-expect-error
                og.__dbg_ru1n[owner] || objectCreate(null);
            if (mode === "rw") {
                //@ts-expect-error
                og.__dbg_ru1n[owner][prop] = "rw";
            } else {
                //@ts-expect-error
                if (og.__dbg_ru1n[owner][prop] !== "rw") {
                    //@ts-expect-error
                    og.__dbg_ru1n[owner][prop] = "r";
                }
            }
        };
        const wrapRealmCarrier = (value: object) => {
            if (realmCarrierCache == null) {
                realmCarrierCache = new weakMapCtor<object, object>();
                boundHostFunctionCache = new weakMapCtor<Function, Function>();
            }
            const existing = realmCarrierCache.get(value);
            if (existing != null) {
                return existing;
            }
            const handler: ProxyHandler<object> = {
                get(target, prop) {
                    const nested = reflectGet(target, prop, target);
                    if (nested === og) {
                        const descriptor = reflectGetOwnPropertyDescriptor(
                            target,
                            prop,
                        );
                        if (
                            descriptor != null &&
                            descriptor.configurable === false &&
                            "value" in descriptor &&
                            descriptor.writable === false
                        ) {
                            throwInvariantDenied(
                                "Realm back-reference access to",
                                prop,
                            );
                        }
                        return sandbox;
                    }
                    if (typeof nested === "function") {
                        let bound = boundHostFunctionCache!.get(nested);
                        if (bound == null) {
                            const created = reflectApply(
                                functionBind,
                                nested,
                                [target],
                            ) as Function;
                            boundHostFunctionCache!.set(nested, created);
                            bound = created;
                        }
                        return bound;
                    }
                    return nested;
                },
                set(target, prop, nested) {
                    return reflectSet(target, prop, nested, target);
                },
                defineProperty(target, prop, descriptor) {
                    return reflectDefineProperty(target, prop, descriptor);
                },
                deleteProperty(target, prop) {
                    return reflectDeleteProperty(target, prop);
                },
            };
            objectFreeze(handler);
            const wrapped = new proxyCtor(value, handler);
            realmCarrierCache.set(value, wrapped);
            return wrapped;
        };
        const readGlobal = (target: typeof og, prop: PropertyKey) => {
            if (isGlobalAlias(prop)) {
                return sandbox;
            }
            let value = reflectGet(target, prop, target);
            if (value === og) {
                return sandbox;
            }
            if (
                prop === "document" &&
                value != null &&
                typeof value === "object"
            ) {
                value = wrapRealmCarrier(value);
            }
            if (
                typeof value === "function" &&
                includes(hostFunctions, prop)
            ) {
                value = bindToGlobal(value);
            }
            return value;
        };
        const warnDenied = (operation: string, prop?: PropertyKey) => {
            const target =
                prop === undefined
                    ? "global object"
                    : `global variable "${stringCtor(prop)}"`;
            console.warn(
                `${operation} ${target} is denied by policy${deniedForOwner}.`,
            );
        };
        const throwInvariantDenied = (
            operation: string,
            prop?: PropertyKey,
        ): never => {
            const target =
                prop === undefined
                    ? "global object"
                    : `global variable "${stringCtor(prop)}"`;
            throw new typeErrorCtor(
                `[Warden] ${operation} ${target} is denied by policy${deniedForOwner}.`,
            );
        };

        const handler: ProxyHandler<typeof og> = {
            get(target, prop) {
                if (isReadAllowed(prop)) {
                    return readGlobal(target, prop);
                }
                if (canDiscover(prop)) {
                    recordDevAccess(prop, "r");
                    return readGlobal(target, prop);
                }
                warnDenied("Access to", prop);
                return undefined;
            },

            getOwnPropertyDescriptor(target, prop) {
                const descriptor = reflectGetOwnPropertyDescriptor(
                    target,
                    prop,
                );
                const allowed = isReadAllowed(prop);
                if (!allowed && !canDiscover(prop)) {
                    warnDenied("Descriptor access to", prop);
                    if (
                        descriptor != null &&
                        (descriptor.configurable === false ||
                            !reflectIsExtensible(target))
                    ) {
                        throwInvariantDenied("Descriptor access to", prop);
                    }
                    return undefined;
                }
                if (!allowed) {
                    recordDevAccess(prop, "r");
                }

                if (descriptor == null) {
                    return isGlobalAlias(prop) && reflectIsExtensible(target)
                        ? {
                              configurable: true,
                              enumerable: false,
                              value: sandbox,
                              writable: false,
                          }
                        : undefined;
                }

                const value = readGlobal(target, prop);
                if (descriptor.configurable !== false) {
                    return {
                        configurable: true,
                        enumerable: descriptor.enumerable === true,
                        value,
                        writable:
                            dev ||
                            typeof prop === "symbol" ||
                            getRule(prop) === "rw",
                    };
                }

                if (
                    isGlobalAlias(prop) ||
                    ("value" in descriptor && descriptor.value !== value) ||
                    ("set" in descriptor &&
                        descriptor.set != null &&
                        !dev &&
                        typeof prop !== "symbol" &&
                        getRule(prop) !== "rw")
                ) {
                    throwInvariantDenied("Safe descriptor access to", prop);
                }
                return descriptor;
            },

            has(target, prop) {
                if (isReadAllowed(prop)) {
                    return isGlobalAlias(prop) || reflectHas(target, prop);
                }
                if (canDiscover(prop)) {
                    recordDevAccess(prop, "r");
                    return reflectHas(target, prop);
                }

                warnDenied("Existence check for", prop);
                const descriptor = reflectGetOwnPropertyDescriptor(
                    target,
                    prop,
                );
                if (
                    descriptor != null &&
                    (descriptor.configurable === false ||
                        !reflectIsExtensible(target))
                ) {
                    throwInvariantDenied("Existence check for", prop);
                }
                return false;
            },

            ownKeys(target) {
                const keys = reflectOwnKeys(target);
                const extensible = reflectIsExtensible(target);
                const visibleKeys: (string | symbol)[] = [];
                const appendVisibleKey = (key: string | symbol) => {
                    if (canDiscover(key)) {
                        recordDevAccess(key, "r");
                        visibleKeys.push(key);
                        return;
                    }
                    if (isReadAllowed(key)) {
                        visibleKeys.push(key);
                        return;
                    }
                    const descriptor = reflectGetOwnPropertyDescriptor(
                        target,
                        key,
                    );
                    if (
                        descriptor?.configurable === false ||
                        !extensible
                    ) {
                        // Proxy invariants require these keys to be reported.
                        // Their descriptor/value remains blocked above.
                        visibleKeys.push(key);
                    }
                };
                for (const key of keys) {
                    appendVisibleKey(key);
                }
                if (dev) {
                    return visibleKeys;
                }

                // Some host globals materialize additional own keys while
                // their descriptors are inspected. A fresh, bounded pass
                // includes those keys without repeatedly triggering host
                // lazy initialization.
                for (const latestKey of reflectOwnKeys(target)) {
                    let alreadySeen = false;
                    for (const existingKey of keys) {
                        if (existingKey === latestKey) {
                            alreadySeen = true;
                            break;
                        }
                    }
                    if (!alreadySeen) {
                        appendVisibleKey(latestKey);
                    }
                }
                return visibleKeys;
            },

            getPrototypeOf(target) {
                const prototype = reflectGetPrototypeOf(target);
                if (prototype === null || reflectIsExtensible(target)) {
                    return null;
                }
                return throwInvariantDenied("Prototype access to");
            },

            set(target, prop, value) {
                if (getRule(prop) === "rw" || typeof prop === "symbol") {
                    return reflectSet(target, prop, value, target);
                } else if (canDiscover(prop)) {
                    recordDevAccess(prop, "rw");
                    return reflectSet(target, prop, value, target);
                } else {
                    warnDenied("Set to", prop);
                    return false;
                }
            },

            deleteProperty(target, prop) {
                if (getRule(prop) === "rw" || typeof prop === "symbol") {
                    return reflectDeleteProperty(target, prop);
                } else if (canDiscover(prop)) {
                    recordDevAccess(prop, "rw");
                    return reflectDeleteProperty(target, prop);
                } else {
                    warnDenied("Delete of", prop);
                    return false;
                }
            },

            defineProperty(target, prop, descriptor) {
                if (getRule(prop) === "rw" || typeof prop === "symbol") {
                    return reflectDefineProperty(target, prop, descriptor);
                } else if (canDiscover(prop)) {
                    recordDevAccess(prop, "rw");
                    return reflectDefineProperty(target, prop, descriptor);
                } else {
                    warnDenied("Define of", prop);
                    return false;
                }
            },

            setPrototypeOf() {
                warnDenied("Mutation of prototype for");
                return false;
            },

            preventExtensions() {
                warnDenied("Preventing extensions on");
                return false;
            },

            isExtensible(target) {
                return reflectIsExtensible(target);
            },
        };

        objectFreeze(handler);
        const sandbox = new proxyCtor(og, handler);
        return sandbox;
    };
};

export const mkCompartment = mkCompartmentFactory(ECMAGlobals, globalFuncs);

export function getMkCompartmentSource() {
    return `(${mkCompartmentFactory.toString()})(${JSON.stringify(ECMAGlobals)}, ${JSON.stringify(globalFuncs)})`;
}
