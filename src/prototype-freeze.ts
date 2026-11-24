import {
    prototypeProtectionPlan,
    type PrototypeProtectionPlan,
    type PrototypeProtectionStrategy,
} from "./prototype-protection";

export const prototypeFreezeAssetName = "warden-prototype-freeze.js";
export const prototypeFreezeMarker = "warden-prototype-freeze";

export type PrototypeFreezeMode = "compat" | "strict";

/**
 * This function is serialized into a standalone browser asset. Keep every
 * runtime dependency inside the function body or pass it as serialized data.
 */
const applyPrototypeProtection = (
    plan: PrototypeProtectionPlan,
    mode: PrototypeFreezeMode,
) => {
    "use strict";

    const objectCtor = Object;
    const functionCtor = Function;
    const reflectObject = Reflect;
    const globalObject = globalThis as Record<string, unknown>;
    const objectPrototype = objectCtor.prototype;
    const functionPrototype = functionCtor.prototype;

    const defineProperty = objectCtor.defineProperty;
    const freeze = objectCtor.freeze;
    const getOwnPropertyDescriptor = objectCtor.getOwnPropertyDescriptor;
    const getOwnPropertyNames = objectCtor.getOwnPropertyNames;
    const getOwnPropertySymbols = objectCtor.getOwnPropertySymbols;
    const getPrototypeOf = objectCtor.getPrototypeOf;
    const isFrozen = objectCtor.isFrozen;
    const keys = objectCtor.keys;
    const reflectApply = reflectObject.apply;
    const errorCtor = Error;
    const stringCtor = String;
    const typeErrorCtor = TypeError;
    const weakSetCtor = WeakSet;

    if (mode !== "compat" && mode !== "strict") {
        throw new typeErrorCtor(
            `[Warden] Invalid prototype freeze mode "${stringCtor(mode)}"`,
        );
    }

    const fail = (target: string, cause?: unknown): never => {
        const detail =
            cause instanceof errorCtor && cause.message
                ? `: ${cause.message}`
                : "";
        throw new errorCtor(
            `[Warden] Failed to lock prototype target "${target}"${detail}`,
        );
    };
    const denyMutation = (target: string): never => {
        throw new typeErrorCtor(
            `[Warden] Modification of locked target "${target}" is not allowed`,
        );
    };

    // Buffer and other Uint8Array subclasses install their own methods with
    // ordinary assignment. Their shared %TypedArray% ancestors therefore stay
    // extensible, but all properties that already exist on those ancestors are
    // locked below with derived-object overrides enabled.
    const uint8ArrayCtor = globalObject.Uint8Array;
    let sharedTypedArrayConstructor: unknown;
    let sharedTypedArrayPrototype: unknown;
    if (typeof uint8ArrayCtor === "function") {
        try {
            sharedTypedArrayConstructor = getPrototypeOf(uint8ArrayCtor);
            const uint8ArrayPrototype = (
                uint8ArrayCtor as { prototype?: unknown }
            ).prototype;
            if (uint8ArrayPrototype != null) {
                sharedTypedArrayPrototype = getPrototypeOf(
                    uint8ArrayPrototype,
                );
            }
        } catch (error) {
            fail("Uint8Array compatibility ancestors", error);
        }
    }

    const lockProperty = (
        owner: object,
        property: PropertyKey,
        target: string,
    ) => {
        const descriptor = getOwnPropertyDescriptor(owner, property);
        if (descriptor == null) {
            return;
        }

        try {
            const lockedDescriptor: PropertyDescriptor = {
                ...descriptor,
                configurable: false,
            };
            if ("writable" in lockedDescriptor) {
                lockedDescriptor.writable = false;
            }
            defineProperty(owner, property, lockedDescriptor);

            const result = getOwnPropertyDescriptor(owner, property);
            if (
                result == null ||
                result.configurable === true ||
                ("writable" in result && result.writable === true)
            ) {
                fail(target);
            }
        } catch (error) {
            fail(target, error);
        }
    };

    const lockPropertyWithDerivedOverrides = (
        owner: object,
        property: PropertyKey,
        target: string,
    ) => {
        const descriptor = getOwnPropertyDescriptor(owner, property);
        if (descriptor == null) {
            return;
        }

        // A non-writable inherited data property also prevents ordinary
        // assignment from creating an own property on a derived object. Keep
        // the primordial immutable on its owner while allowing libraries to
        // attach APIs such as `fn.call = ...` or `Buffer.prototype.slice = ...`.
        if (
            "value" in descriptor &&
            descriptor.writable === true &&
            descriptor.configurable !== false
        ) {
            const originalValue = descriptor.value;
            try {
                const getOriginalValue = () => originalValue;
                // get-intrinsic and the wider es-shim ecosystem recognize
                // this marker as the standard workaround for the inherited
                // override mistake and unwrap the original data value.
                defineProperty(getOriginalValue, "originalValue", {
                    configurable: false,
                    enumerable: false,
                    value: originalValue,
                    writable: false,
                });
                defineProperty(owner, property, {
                    configurable: false,
                    enumerable: descriptor.enumerable === true,
                    get: getOriginalValue,
                    set: function (this: unknown, value: unknown) {
                        if (
                            this === owner ||
                            ((typeof this !== "object" || this === null) &&
                                typeof this !== "function")
                        ) {
                            denyMutation(target);
                        }

                        try {
                            defineProperty(this, property, {
                                configurable: true,
                                enumerable: true,
                                value,
                                writable: true,
                            });
                        } catch (error) {
                            fail(`${target} derived override`, error);
                        }
                    },
                });

                const result = getOwnPropertyDescriptor(owner, property);
                if (
                    result == null ||
                    result.configurable === true ||
                    typeof result.get !== "function" ||
                    typeof result.set !== "function"
                ) {
                    fail(target);
                }
            } catch (error) {
                fail(target, error);
            }
            return;
        }

        // A configurable intrinsic setter can still mutate a frozen-looking
        // owner. Guard the owner while preserving the native setter for
        // derived receivers (notably Object.prototype.__proto__).
        if (
            !("value" in descriptor) &&
            typeof descriptor.set === "function" &&
            descriptor.configurable !== false
        ) {
            const originalSetter = descriptor.set;
            try {
                const lockedAccessor: PropertyDescriptor = {
                    configurable: false,
                    enumerable: descriptor.enumerable === true,
                    set: function (this: unknown, value: unknown) {
                        if (this === owner) {
                            denyMutation(target);
                        }
                        return reflectApply(originalSetter, this, [value]);
                    },
                };
                if (descriptor.get !== undefined) {
                    lockedAccessor.get = descriptor.get;
                }
                defineProperty(owner, property, lockedAccessor);
            } catch (error) {
                fail(target, error);
            }
            return;
        }

        lockProperty(owner, property, target);
    };

    const isExcluded = (
        property: PropertyKey,
        excludedProperties: readonly string[],
    ) => {
        if (typeof property !== "string") {
            return false;
        }
        for (const excludedProperty of excludedProperties) {
            if (property === excludedProperty) {
                return true;
            }
        }
        return false;
    };

    const lockTargetProperties = (
        value: unknown,
        target: string,
        excludedProperties: readonly string[] = [],
        directLockProperties: readonly string[] = [],
    ) => {
        if (
            (typeof value !== "object" || value === null) &&
            typeof value !== "function"
        ) {
            return;
        }

        for (const property of getOwnPropertyNames(value)) {
            if (!isExcluded(property, excludedProperties)) {
                const propertyTarget = `${target}.${property}`;
                if (isExcluded(property, directLockProperties)) {
                    lockProperty(value, property, propertyTarget);
                } else {
                    lockPropertyWithDerivedOverrides(
                        value,
                        property,
                        propertyTarget,
                    );
                }
            }
        }
        for (const property of getOwnPropertySymbols(value)) {
            lockPropertyWithDerivedOverrides(
                value,
                property,
                `${target}[${stringCtor(property)}]`,
            );
        }
    };

    const strictHardenedTargets = new weakSetCtor<object>();
    const freezeTarget = (value: unknown, target: string) => {
        if (
            (typeof value !== "object" || value === null) &&
            typeof value !== "function"
        ) {
            return;
        }

        try {
            if (mode === "strict") {
                if (strictHardenedTargets.has(value)) {
                    return;
                }
                strictHardenedTargets.add(value);
                for (const property of getOwnPropertyNames(value)) {
                    const descriptor = getOwnPropertyDescriptor(
                        value,
                        property,
                    );
                    if (descriptor == null) {
                        continue;
                    }
                    if ("value" in descriptor) {
                        freezeTarget(
                            descriptor.value,
                            `${target}.${property}`,
                        );
                    } else {
                        freezeTarget(
                            descriptor.get,
                            `${target}.${property}[[Get]]`,
                        );
                        freezeTarget(
                            descriptor.set,
                            `${target}.${property}[[Set]]`,
                        );
                    }
                }
                for (const property of getOwnPropertySymbols(value)) {
                    const descriptor = getOwnPropertyDescriptor(
                        value,
                        property,
                    );
                    if (descriptor == null) {
                        continue;
                    }
                    if ("value" in descriptor) {
                        freezeTarget(
                            descriptor.value,
                            `${target}[${stringCtor(property)}]`,
                        );
                    } else {
                        freezeTarget(
                            descriptor.get,
                            `${target}[${stringCtor(property)}][[Get]]`,
                        );
                        freezeTarget(
                            descriptor.set,
                            `${target}[${stringCtor(property)}][[Set]]`,
                        );
                    }
                }
            }
            lockTargetProperties(value, target);
            freeze(value);
            if (!isFrozen(value)) {
                fail(target);
            }
        } catch (error) {
            fail(target, error);
        }
    };

    const getCompatExceptions = (target: string) => {
        if (mode === "strict") {
            return [];
        }
        const exceptions = plan.compatMutableProperties as Record<
            string,
            readonly string[] | undefined
        >;
        return exceptions[target] ?? [];
    };

    const getDirectLockProperties = (target: string) => {
        const properties = plan.directLockProperties as Record<
            string,
            readonly string[] | undefined
        >;
        return properties[target] ?? [];
    };

    const isCompatManagedConstructor = (value: unknown) => {
        if (mode !== "compat") {
            return false;
        }
        const exceptions = plan.compatMutableProperties as Record<
            string,
            readonly string[] | undefined
        >;
        for (const target of keys(exceptions)) {
            if (!target.endsWith(".prototype") && globalObject[target] === value) {
                return true;
            }
        }
        return false;
    };

    const freezeConstructor = (
        value: unknown,
        target: string,
        freezeConstructorObject = true,
    ) => {
        if (typeof value !== "function") {
            return;
        }

        if (freezeConstructorObject) {
            freezeTarget(value, target);

            let constructorParent = getPrototypeOf(value);
            while (
                constructorParent != null &&
                constructorParent !== functionPrototype &&
                constructorParent !== sharedTypedArrayConstructor &&
                !isCompatManagedConstructor(constructorParent)
            ) {
                freezeTarget(
                    constructorParent,
                    `${target}[[ConstructorPrototype]]`,
                );
                constructorParent = getPrototypeOf(constructorParent);
            }
        }

        let prototype = (value as { prototype?: unknown }).prototype;
        while (
            prototype != null &&
            prototype !== objectPrototype &&
            prototype !== sharedTypedArrayPrototype
        ) {
            freezeTarget(prototype, `${target}.prototype`);
            prototype = getPrototypeOf(prototype);
        }
    };

    const lockConstructor = (value: unknown, target: string) => {
        if (typeof value !== "function") {
            return;
        }
        lockTargetProperties(
            value,
            target,
            getCompatExceptions(target),
            getDirectLockProperties(target),
        );
        const prototypeTarget = `${target}.prototype`;
        lockTargetProperties(
            (value as { prototype?: unknown }).prototype,
            prototypeTarget,
            getCompatExceptions(prototypeTarget),
            getDirectLockProperties(prototypeTarget),
        );
    };

    const freezeConstructorNamespace = (value: unknown, target: string) => {
        if (value == null || typeof value !== "object") {
            return;
        }
        for (const property of getOwnPropertyNames(value)) {
            const nestedValue = (value as Record<string, unknown>)[property];
            if (
                typeof nestedValue === "function" &&
                (nestedValue as { prototype?: unknown }).prototype != null
            ) {
                freezeConstructor(nestedValue, `${target}.${property}`);
            }
        }
        freezeTarget(value, target);
    };

    const applyStrategy = (
        name: string,
        strategy: PrototypeProtectionStrategy,
    ) => {
        const value = globalObject[name];
        switch (strategy) {
            case "freeze-constructor":
                freezeConstructor(value, name);
                break;
            case "lock-constructor":
                lockConstructor(value, name);
                break;
            case "lock-constructor-freeze-prototype":
                if (mode === "strict") {
                    freezeConstructor(value, name);
                } else {
                    lockConstructor(value, name);
                    freezeConstructor(value, name, false);
                }
                break;
            case "freeze-prototype":
                freezeConstructor(value, name, false);
                break;
            case "freeze-object":
                freezeTarget(value, name);
                break;
            case "lock-object":
                lockTargetProperties(value, name);
                break;
            case "freeze-constructor-namespace":
                freezeConstructorNamespace(value, name);
                break;
            case "immutable-value":
            case "unprotected-global-function":
            case "realm-global":
                break;
            default:
                fail(`${name} protection strategy`);
        }
    };

    const ecmaGlobalPlan = plan.ecmaGlobals as Record<
        string,
        PrototypeProtectionStrategy
    >;
    for (const name of keys(ecmaGlobalPlan)) {
        applyStrategy(name, ecmaGlobalPlan[name]!);
    }

    for (const name of plan.browserConstructors) {
        freezeConstructor(globalObject[name], name);
    }

    for (const path of plan.frozenBrowserObjects) {
        let value: unknown = globalObject;
        let target = "";
        for (const property of path) {
            target = target === "" ? property : `${target}.${property}`;
            if (
                (typeof value !== "object" || value === null) &&
                typeof value !== "function"
            ) {
                value = undefined;
                break;
            }
            try {
                value = (value as Record<string, unknown>)[property];
            } catch (error) {
                fail(target, error);
            }
        }

        if (
            (typeof value === "object" && value !== null) ||
            typeof value === "function"
        ) {
            let prototype: object | null | undefined;
            try {
                prototype = getPrototypeOf(value);
            } catch (error) {
                fail(`${target}[[Prototype]]`, error);
            }
            freezeTarget(prototype, `${target}[[Prototype]]`);
            freezeTarget(value, target);
        }
    }

    if (plan.sharedTypedArrayAncestors === "lock-own-properties") {
        if (mode === "strict") {
            freezeTarget(sharedTypedArrayConstructor, "%TypedArray%");
            freezeTarget(
                sharedTypedArrayPrototype,
                "%TypedArray%.prototype",
            );
        } else {
            lockTargetProperties(
                sharedTypedArrayConstructor,
                "%TypedArray%",
            );
            lockTargetProperties(
                sharedTypedArrayPrototype,
                "%TypedArray%.prototype",
            );
        }
    }

    if (mode === "strict") {
        for (const name of plan.strictFrozenConstructors) {
            freezeConstructor(globalObject[name], name);
        }
        for (const name of plan.strictBrowserConstructors) {
            freezeConstructor(globalObject[name], name);
        }
        for (const name of plan.strictFrozenPrototypes) {
            const value = globalObject[name];
            if (typeof value === "function") {
                freezeTarget(
                    (value as { prototype?: unknown }).prototype,
                    `${name}.prototype`,
                );
            }
        }

        if (plan.strictIntrinsicPrototypeChains) {
            const freezePrototypeChain = (value: unknown, target: string) => {
                if (
                    (typeof value !== "object" || value === null) &&
                    typeof value !== "function"
                ) {
                    return;
                }
                let prototype = getPrototypeOf(value);
                let depth = 0;
                while (
                    prototype != null &&
                    prototype !== objectPrototype &&
                    prototype !== functionPrototype
                ) {
                    freezeTarget(
                        prototype,
                        `${target}[[Prototype:${depth}]]`,
                    );
                    prototype = getPrototypeOf(prototype);
                    depth += 1;
                }
            };

            const symbolCtor = globalObject.Symbol as
                | { iterator?: symbol }
                | undefined;
            const iteratorSymbol = symbolCtor?.iterator;
            if (typeof iteratorSymbol === "symbol") {
                const getIterator = (value: object) => {
                    const method = (
                        value as Record<PropertyKey, unknown>
                    )[iteratorSymbol];
                    return typeof method === "function"
                        ? reflectApply(method, value, [])
                        : undefined;
                };
                freezePrototypeChain(
                    getIterator([]),
                    "%ArrayIteratorPrototype%",
                );
                freezePrototypeChain(
                    getIterator(new stringCtor("")),
                    "%StringIteratorPrototype%",
                );
                const mapCtor = globalObject.Map as
                    | (new () => Map<unknown, unknown>)
                    | undefined;
                if (typeof mapCtor === "function") {
                    freezePrototypeChain(
                        getIterator(new mapCtor()),
                        "%MapIteratorPrototype%",
                    );
                }
                const setCtor = globalObject.Set as
                    | (new () => Set<unknown>)
                    | undefined;
                if (typeof setCtor === "function") {
                    freezePrototypeChain(
                        getIterator(new setCtor()),
                        "%SetIteratorPrototype%",
                    );
                }
            }

            const generatorFunction = function* () {};
            freezePrototypeChain(
                generatorFunction,
                "%GeneratorFunction.prototype%",
            );
            freezePrototypeChain(
                generatorFunction(),
                "%GeneratorPrototype%",
            );

            const asyncFunction = async function () {};
            freezePrototypeChain(
                asyncFunction,
                "%AsyncFunction.prototype%",
            );

            const asyncGeneratorFunction = async function* () {};
            freezePrototypeChain(
                asyncGeneratorFunction,
                "%AsyncGeneratorFunction.prototype%",
            );
            freezePrototypeChain(
                asyncGeneratorFunction(),
                "%AsyncGeneratorPrototype%",
            );
        }
    }
};

export const prototypeFreezeBootstrap = (
    mode: PrototypeFreezeMode = "compat",
) => applyPrototypeProtection(prototypeProtectionPlan, mode);

export function getPrototypeFreezeBootstrapSource(
    mode: PrototypeFreezeMode = "compat",
) {
    return (
        `/* ${prototypeFreezeMarker} */\n;(` +
        `${applyPrototypeProtection.toString()})` +
        `(${JSON.stringify(prototypeProtectionPlan)}, ${JSON.stringify(mode)});\n`
    );
}
