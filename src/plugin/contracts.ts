import type { GlobalAccessMode } from "../globals";
import type { PrototypeFreezeMode } from "../prototype-freeze";

export const pluginName = "WardenPlugin";

export type WardenPluginOptions = {
    dev?: boolean;
    policyOverPath?: string;
    policyOutputPath?: string;
    freezePrototypes?: boolean;
    prototypeFreezeMode?: PrototypeFreezeMode;
    protectWebpackRequire?: boolean;
    forceCheck?: boolean;
};

export type WardenPluginConfig = Required<WardenPluginOptions>;

export type GlobalPolicy = Record<string, GlobalAccessMode>;

/** One `policy-over.json` entry, keyed by package name ("a" or "a > b"). */
export type PolicyOverride = {
    /** `false` runs the package outside the global Proxy sandbox. */
    enable?: boolean;
    /** `false` keeps the package's sloppy-mode modules sloppy. */
    strict?: boolean;
    global?: {
        allow?: GlobalPolicy;
        disallow?: string[];
    };
    webpackRequire?: {
        allow?: string[];
    };
};

/** One `policy.json` entry, keyed by package name ("a" or "a > b"). */
export type OutputPackagePolicy = {
    enable: boolean;
    /** Present (as `false`) only for packages opted out of strict mode. */
    strict?: false;
    require?: string[];
    global?: GlobalPolicy;
    disallow?: string[];
};

export function normalizePluginOptions(
    options: WardenPluginOptions = {},
): WardenPluginConfig {
    const dev = options.dev ?? true;
    const prototypeFreezeMode = options.prototypeFreezeMode ?? "compat";
    if (
        prototypeFreezeMode !== "compat" &&
        prototypeFreezeMode !== "strict"
    ) {
        throw new TypeError(
            `[${pluginName}] prototypeFreezeMode must be "compat" or "strict".`,
        );
    }

    return {
        dev,
        policyOverPath: options.policyOverPath ?? "SecSDK/policy-over.json",
        policyOutputPath: options.policyOutputPath ?? "SecSDK/policy.json",
        freezePrototypes: options.freezePrototypes ?? true,
        prototypeFreezeMode,
        protectWebpackRequire: options.protectWebpackRequire ?? true,
        // Production mode must not silently downgrade policy violations to
        // warnings. Callers can still opt out explicitly while migrating.
        forceCheck: options.forceCheck ?? !dev,
    };
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

/** Text of a webpack source, or null for binary content. */
export function getSourceCode(source: { source: () => unknown }) {
    const value = source.source();
    if (Buffer.isBuffer(value)) {
        return value.toString("utf-8");
    }
    return typeof value === "string" ? value : null;
}
