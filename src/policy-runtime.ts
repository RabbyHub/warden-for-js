import type { RuntimeGlobalAccessMode } from "./global/types";

export const policyRuntimeAssetName = "warden-policy-runtime.js";
export const policyRuntimeMarker = "warden-policy-runtime";
export const policyRuntimeLoaderMarker = "warden-policy-runtime-loader";
export const policyGlobalName = "__wardenPolicy";

export type WebpackModuleId = string | number;
export type GlobalRules = Record<string, RuntimeGlobalAccessMode>;

/**
 * One npm package:
 * [name, global rules (null = sandbox disabled), webpack require helpers,
 *  indexes of packages it may require, extra module ids it may require,
 *  ids of its own modules]
 */
export type PackagePolicyRow = [
    name: string,
    rules: GlobalRules | null,
    properties: string[],
    packages: number[],
    modules: WebpackModuleId[],
    ownModules: WebpackModuleId[],
];

/** Third-party packages plus the ids of the unprotected first-party modules. */
export type PolicyTable = [
    packages: PackagePolicyRow[],
    firstPartyModules: WebpackModuleId[],
];

export type RuntimePackagePolicy = {
    readonly index: number;
    readonly name: string;
    readonly rules: Readonly<GlobalRules> | null;
    readonly properties: Readonly<Record<string, true>>;
    readonly packages: Readonly<Record<number, true>>;
    readonly modules: Readonly<Record<string, true>>;
};

export type RuntimePolicy = {
    /** Package owning a module, `null` for first-party, `undefined` if unknown. */
    readonly lookup: (
        moduleId: unknown,
    ) => RuntimePackagePolicy | null | undefined;
    readonly allows: (pkg: RuntimePackagePolicy, moduleId: unknown) => boolean;
};

// Serialized into generated code through toString(): the body must stay
// self-contained and must not reference module-scope bindings.
export const decodePolicyTable = (table: PolicyTable): RuntimePolicy => {
    const create = Object.create;
    const freeze = Object.freeze;
    const keys = Object.keys;
    const isInteger = Number.isInteger;
    const fail = (message: string): never => {
        throw new Error(`[Warden] ${message}`);
    };
    // Numeric and string ids stay distinct: 1 and "1" are different grants.
    const idKey = (id: unknown) =>
        typeof id === "string"
            ? `s:${id}`
            : typeof id === "number" && isInteger(id)
              ? `n:${id}`
              : null;
    const toSet = <T>(values: T[], toKey: (value: T) => PropertyKey | null) => {
        const set = create(null);
        for (const value of values) {
            const key = toKey(value);
            if (key == null || set[key] === true) {
                fail(`Invalid or duplicate policy value "${String(value)}"`);
            }
            set[key as PropertyKey] = true;
        }
        return freeze(set);
    };

    const rows = table[0];
    const owners: Record<string, RuntimePackagePolicy | null> = create(null);
    const claim = (id: unknown, owner: RuntimePackagePolicy | null) => {
        const key = idKey(id);
        if (key == null || key in owners) {
            fail(`Invalid or duplicate webpack module id "${String(id)}"`);
        }
        owners[key as string] = owner;
    };

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const name = row[0];
        if (typeof name !== "string" || name.length === 0) {
            fail("Invalid package name in policy");
        }
        let rules: GlobalRules | null = null;
        if (row[1] != null) {
            rules = create(null) as GlobalRules;
            for (const key of keys(row[1])) {
                const mode = row[1][key];
                if (mode === "r" || mode === "rw" || mode === "deny") {
                    rules[key] = mode;
                } else {
                    fail(`Invalid policy mode for "${key}" in "${name}"`);
                }
            }
            freeze(rules);
        }
        const pkg: RuntimePackagePolicy = freeze({
            index,
            name,
            rules,
            properties: toSet(row[2], (property) =>
                typeof property === "string" && property.length > 0
                    ? property
                    : null,
            ),
            packages: toSet(row[3], (target) =>
                isInteger(target) && target >= 0 && target < rows.length
                    ? target
                    : null,
            ),
            modules: toSet(row[4], idKey),
        });
        for (const id of row[5]) {
            claim(id, pkg);
        }
    }
    for (const id of table[1]) {
        claim(id, null);
    }
    freeze(owners);

    return freeze({
        lookup: freeze((moduleId: unknown) => {
            const key = idKey(moduleId);
            return key == null ? undefined : owners[key];
        }),
        allows: freeze((pkg: RuntimePackagePolicy, moduleId: unknown) => {
            const key = idKey(moduleId);
            if (key == null) {
                return false;
            }
            const owner = owners[key];
            return (
                owner === pkg ||
                (owner != null && pkg.packages[owner.index] === true) ||
                pkg.modules[key] === true
            );
        }),
    });
};

/** Shared policy asset loaded by HTML pages and the service worker. */
export function getPolicyRuntimeSource(table: PolicyTable) {
    const name = JSON.stringify(policyGlobalName);
    return `/* ${policyRuntimeMarker} */
;(() => {
    "use strict";
    if (Object.getOwnPropertyDescriptor(globalThis, ${name}) != null) {
        throw new Error('[Warden] Policy runtime global ${policyGlobalName} already exists');
    }
    Object.defineProperty(globalThis, ${name}, {
        configurable: false,
        enumerable: false,
        value: (${decodePolicyTable.toString()})(${JSON.stringify(table)}),
        writable: false,
    });
})();
`;
}
