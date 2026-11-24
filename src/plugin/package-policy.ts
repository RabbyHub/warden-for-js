import type { Chunk, Compilation, Module } from "webpack";
import type {
    GlobalRules,
    PackagePolicyRow,
    PolicyTable,
    WebpackModuleId,
} from "../policy-runtime";
import { ECMAGlobals } from "../global/capabilities";
import {
    pluginName,
    type GlobalPolicy,
    type OutputPackagePolicy,
    type PolicyOverride,
    type WardenPluginConfig,
} from "./contracts";
import { mergeGlobalAccess } from "./global-analysis";
import { getInnerModules, ModuleOwners } from "./packages";

// Every `__webpack_require__.<helper>` Warden knows how to guard. A helper
// missing here fails the build instead of being exposed unreviewed.
const supportedRequireProperties = new Set(
    (
        "amdD amdO a aD aE b c cn d dn e E f F g G h hk hmd hmrC hmrD hmrF " +
        "hmrI hmrM hmrS hu H I is j k l m n nc nmd o O oe p r R s S System " +
        "t tb ts tt tu u U v vs w y z zO zS zT"
    ).split(" "),
);

type PackagePolicy = {
    name: string;
    /** Whether the package runs inside the global Proxy sandbox. */
    enable: boolean;
    /** Whether its modules are forced into strict mode. */
    strict: boolean;
    global: GlobalPolicy;
    disallow?: Set<string>;
    properties: Set<string>;
    requirePackages: Set<string>;
    /** Modules outside any package it may require: label -> module ids. */
    requireModules: Map<string, Set<WebpackModuleId>>;
    moduleIds: Set<WebpackModuleId>;
    /** Has code in the final bundle, so it belongs in `policy.json`. */
    bundled: boolean;
};

const compareIds = (left: WebpackModuleId, right: WebpackModuleId) =>
    typeof left === "number" && typeof right === "number"
        ? left - right
        : typeof left === typeof right
          ? String(left).localeCompare(String(right))
          : typeof left === "number"
            ? -1
            : 1;

const sortKeys = <T>(record: Record<string, T>) => {
    const result: Record<string, T> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
        result[key] = record[key]!;
    }
    return result;
};

const addToMap = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => {
    let values = map.get(key);
    if (values == null) {
        map.set(key, (values = new Set()));
    }
    values.add(value);
};

/** Modules a factory can actually require in one runtime. */
function getActiveDependencies(
    module: Module,
    runtime: Chunk["runtime"],
    moduleGraph: Compilation["moduleGraph"],
) {
    const result = new Set<Module>();
    const visited = new Set<Module>();
    const visit = (origin: Module) => {
        if (visited.has(origin)) {
            return;
        }
        visited.add(origin);
        for (const connection of moduleGraph.getOutgoingConnections(origin)) {
            const target = connection.module;
            if (target == null) {
                continue;
            }
            if (connection.isTargetActive(runtime)) {
                result.add(target);
            } else if (connection.getActiveState(runtime) !== false) {
                visit(target); // TRANSITIVE_ONLY: skipped, its imports stay
            }
        }
    };
    visit(module);
    return result;
}

/**
 * Per-compilation policy state with npm packages as the unit: which globals
 * each package may touch and which other packages it may require.
 * First-party modules are tracked only so the runtime can tell them apart
 * from unknown modules; they are neither sandboxed nor restricted.
 */
export class PackagePolicies {
    readonly owners: ModuleOwners;
    private readonly packages = new Map<string, PackagePolicy>();
    private readonly moduleGlobals = new Map<Module, GlobalPolicy>();
    private readonly firstPartyModules = new Set<WebpackModuleId>();
    private readonly violations: string[] = [];
    private built = false;

    /**
     * @param internalGlobals webpack runtime names (module cache, chunk
     * loading global) that no package may ever be granted.
     */
    constructor(
        private readonly compilation: Compilation,
        rootDir: string,
        private readonly config: WardenPluginConfig,
        private readonly policyOver: Record<string, PolicyOverride>,
        private readonly internalGlobals: readonly string[],
    ) {
        this.owners = new ModuleOwners(compilation, rootDir);
    }

    /** Whether a package keeps the global sandbox (the default). */
    isSandboxed(packageName: string) {
        return this.policyOver[packageName]?.enable !== false;
    }

    /** Whether a sandboxed package's modules are forced into strict mode. */
    isStrict(packageName: string) {
        return (
            this.isSandboxed(packageName) &&
            this.policyOver[packageName]?.strict !== false
        );
    }

    /** Problems that must fail a checked build, e.g. internals referenced. */
    getViolations() {
        this.build();
        return this.violations;
    }

    recordModuleGlobals(module: Module, globals: GlobalPolicy) {
        this.moduleGlobals.set(module, globals);
    }

    /** Ids of every JavaScript module a runtime chunk can execute. */
    getRuntimeModuleIds(runtimeChunk: Chunk) {
        const { chunkGraph } = this.compilation;
        const ids = new Set<WebpackModuleId>();
        for (const chunk of runtimeChunk.getAllReferencedChunks()) {
            for (const module of this.getChunkFactories(chunk)) {
                ids.add(chunkGraph.getModuleId(module)!);
            }
        }
        return ids;
    }

    /** Compact runtime policy, optionally limited to some module ids. */
    getTable(only?: ReadonlySet<WebpackModuleId>): PolicyTable {
        this.build();
        const keep = (id: WebpackModuleId) => only == null || only.has(id);
        const filterIds = (ids: Iterable<WebpackModuleId>) =>
            [...ids].filter(keep).sort(compareIds);
        const included = [...this.packages.values()]
            .filter((pkg) => [...pkg.moduleIds].some(keep))
            .sort((left, right) => left.name.localeCompare(right.name));
        const indexes = new Map(included.map((pkg, index) => [pkg.name, index]));

        const rows = included.map((pkg): PackagePolicyRow => {
            const rules: GlobalRules = Object.assign(Object.create(null), pkg.global);
            for (const name of pkg.disallow ?? []) {
                rules[name] = "deny";
            }
            return [
                pkg.name,
                pkg.enable ? sortKeys(rules) : null,
                [...pkg.properties].sort(),
                [...pkg.requirePackages]
                    .map((name) => indexes.get(name))
                    .filter((index) => index != null)
                    .sort((left, right) => left - right),
                filterIds(
                    new Set([...pkg.requireModules.values()].flatMap((ids) => [...ids])),
                ),
                filterIds(pkg.moduleIds),
            ];
        });
        return [rows, filterIds(this.firstPartyModules)];
    }

    /** Human-readable effective policy written to `policy.json`. */
    getOutputPolicy() {
        this.build();
        const output: Record<string, OutputPackagePolicy> = {};
        const names = [...this.packages.keys()].sort();
        for (const name of names) {
            const pkg = this.packages.get(name)!;
            if (!pkg.bundled) {
                continue;
            }
            const entry: OutputPackagePolicy = { enable: pkg.enable };
            if (pkg.enable && !pkg.strict) {
                entry.strict = false;
            }
            const required = [
                ...pkg.requirePackages,
                ...pkg.requireModules.keys(),
            ].sort();
            if (required.length > 0) {
                entry.require = required;
            }
            if (Object.keys(pkg.global).length > 0) {
                entry.global = sortKeys(pkg.global);
            }
            if (pkg.disallow?.size) {
                entry.disallow = [...pkg.disallow].sort();
            }
            // An empty policy adds no information beyond the sandbox defaults.
            if (
                !entry.enable ||
                entry.strict === false ||
                entry.require != null ||
                entry.global != null ||
                entry.disallow != null
            ) {
                output[name] = entry;
            }
        }
        return output;
    }

    private getPackage(name: string) {
        let pkg = this.packages.get(name);
        if (pkg == null) {
            pkg = {
                name,
                enable: this.isSandboxed(name),
                strict: this.isStrict(name),
                global: Object.create(null),
                properties: new Set(),
                requirePackages: new Set(),
                requireModules: new Map(),
                moduleIds: new Set(),
                bundled: false,
            };
            this.packages.set(name, pkg);
        }
        return pkg;
    }

    private *getChunkFactories(chunk: Chunk) {
        const { chunkGraph } = this.compilation;
        const modules = chunkGraph.getChunkModulesIterableBySourceType(
            chunk,
            "javascript",
        );
        for (const module of modules ?? []) {
            if (chunkGraph.getModuleId(module) != null) {
                yield module;
            }
        }
    }

    /**
     * Derives the package graph from the sealed compilation. Must run after
     * code generation, when module ids and runtime requirements are final.
     */
    private build() {
        if (this.built) {
            return;
        }
        this.built = true;
        const { chunkGraph, moduleGraph } = this.compilation;
        const protect = this.config.protectWebpackRequire;

        // A factory is one emitted module function; concatenation folds
        // several source modules into a single factory.
        const factoryOf = new Map<Module, Module>();
        const factories = new Set<Module>();
        for (const chunk of this.compilation.chunks) {
            for (const factory of this.getChunkFactories(chunk)) {
                factories.add(factory);
                factoryOf.set(factory, factory);
                for (const inner of getInnerModules(factory)) {
                    factoryOf.set(inner, factory);
                }
            }
        }

        // Without require protection a package only matters to the runtime
        // while it is sandboxed.
        const packageOf = (factory: Module) => {
            const owner = this.owners.ownerOf(factory);
            return owner != null && (protect || this.isSandboxed(owner))
                ? this.getPackage(owner)
                : null;
        };

        const labels = new Map<string, Set<WebpackModuleId>>();
        for (const factory of factories) {
            const id = chunkGraph.getModuleId(factory)!;
            const sources = [factory, ...getInnerModules(factory)];
            for (const source of sources) {
                const owner = this.owners.ownerOf(source);
                if (owner == null) {
                    addToMap(labels, this.owners.labelOf(source), id);
                    continue;
                }
                if (source !== factory && (protect || this.isSandboxed(owner))) {
                    throw new Error(
                        `[${pluginName}] Module of package "${owner}" was concatenated into "${factory.readableIdentifier(this.compilation.requestShortener)}"; package isolation failed.`,
                    );
                }
                const pkg = this.getPackage(owner);
                pkg.bundled = true;
                const globals = this.moduleGlobals.get(source);
                if (globals != null) {
                    mergeGlobalAccess(pkg.global, globals);
                }
            }

            const pkg = packageOf(factory);
            if (pkg == null) {
                this.firstPartyModules.add(id);
                continue;
            }
            pkg.moduleIds.add(id);
            if (!protect) {
                continue;
            }
            for (const runtime of chunkGraph.getModuleRuntimes(factory)) {
                this.addRequireProperties(
                    pkg,
                    factory,
                    chunkGraph.getModuleRuntimeRequirements(factory, runtime),
                );
                for (const dependency of getActiveDependencies(
                    factory,
                    runtime,
                    moduleGraph,
                )) {
                    const target = factoryOf.get(dependency);
                    if (target == null || target === factory) {
                        continue;
                    }
                    const targetPackage = packageOf(target);
                    if (targetPackage == null) {
                        addToMap(
                            pkg.requireModules,
                            this.owners.labelOf(dependency),
                            chunkGraph.getModuleId(target)!,
                        );
                    } else if (targetPackage !== pkg) {
                        pkg.requirePackages.add(targetPackage.name);
                    }
                }
            }
        }

        this.applyOverrides(labels);

        // The webpack runtime's own globals hand out the unguarded require
        // and module cache, so a reference is never turned into a grant.
        for (const pkg of this.packages.values()) {
            for (const name of this.internalGlobals) {
                if (pkg.global[name] != null) {
                    delete pkg.global[name];
                    this.violations.push(
                        `Package ${JSON.stringify(pkg.name)} references the webpack runtime internal ${JSON.stringify(name)}.`,
                    );
                }
            }
        }
    }

    private addRequireProperties(
        pkg: PackagePolicy,
        module: Module,
        runtimeRequirements: Iterable<string>,
    ) {
        for (const requirement of runtimeRequirements) {
            const property = /^__webpack_require__\.([A-Za-z_$][\w$]*)/.exec(
                requirement,
            )?.[1];
            if (property == null) {
                continue;
            }
            if (!supportedRequireProperties.has(property)) {
                throw new Error(
                    `[${pluginName}] Module "${module.readableIdentifier(this.compilation.requestShortener)}" requires unsupported webpack runtime capability "${property}".`,
                );
            }
            pkg.properties.add(property);
        }
    }

    /** Applies `policy-over.json` on top of the detected policy. */
    private applyOverrides(labels: Map<string, Set<WebpackModuleId>>) {
        for (const [name, override] of Object.entries(this.policyOver)) {
            if (/(^|[\\/])node_modules([\\/]|$)/.test(name)) {
                throw new Error(
                    `[${pluginName}] policy-over key ${JSON.stringify(name)} is a file path; policies are keyed by package name, e.g. "a" or "a > b" for a package nested in a's node_modules.`,
                );
            }
            for (const flag of ["enable", "strict"] as const) {
                if (
                    override[flag] !== undefined &&
                    typeof override[flag] !== "boolean"
                ) {
                    throw new Error(
                        `[${pluginName}] "${flag}" for "${name}" must be a boolean.`,
                    );
                }
            }
            const pkg = this.packages.get(name);
            const disallow = override.global?.disallow;
            if (disallow !== undefined) {
                if (
                    !Array.isArray(disallow) ||
                    disallow.some((key) =>
                        typeof key !== "string" || key.length === 0 || key.trim() !== key,
                    )
                ) {
                    throw new Error(
                        `[${pluginName}] global.disallow for ${JSON.stringify(name)} must be an array of non-empty global names.`,
                    );
                }
                const denied = new Set(disallow);
                if (denied.size > 0 && !this.isStrict(name)) {
                    throw new Error(
                        `[${pluginName}] global.disallow requires the strict global sandbox for ${JSON.stringify(name)}.`,
                    );
                }
                for (const key of denied) {
                    if (ECMAGlobals.includes(key) || key === "window" || key === "self") {
                        throw new Error(
                            `[${pluginName}] global.disallow cannot target intrinsic or sandbox alias ${JSON.stringify(key)}.`,
                        );
                    }
                    if (pkg?.global[key] !== undefined) {
                        throw new Error(
                            `[${pluginName}] Package ${JSON.stringify(name)} statically accesses global ${JSON.stringify(key)}, which is explicitly denied by global.disallow.`,
                        );
                    }
                }
                if (pkg != null) {
                    pkg.disallow = denied;
                }
            }
            for (const [global, mode] of Object.entries(
                override.global?.allow ?? {},
            )) {
                if (mode !== "r" && mode !== "rw") {
                    throw new Error(
                        `[${pluginName}] global.allow.${global} for "${name}" must be "r" or "rw".`,
                    );
                }
                if (pkg != null && !pkg.disallow?.has(global)) {
                    // A manual grant replaces the detected mode.
                    pkg.global[global] = mode;
                }
            }

            const webpackRequire: unknown = override.webpackRequire;
            if (webpackRequire == null || !this.config.protectWebpackRequire) {
                continue;
            }
            if (typeof webpackRequire !== "object" || Array.isArray(webpackRequire)) {
                throw new Error(
                    `[${pluginName}] webpackRequire override for "${name}" must be an object.`,
                );
            }
            const unsupported = Object.keys(webpackRequire).filter(
                (key) => key !== "allow",
            );
            if (unsupported.length > 0) {
                throw new Error(
                    `[${pluginName}] Unsupported webpackRequire override field(s) for "${name}": ${unsupported.sort().join(", ")}.`,
                );
            }
            const allow: unknown = override.webpackRequire?.allow;
            if (allow === undefined) {
                continue;
            }
            if (!Array.isArray(allow)) {
                throw new Error(
                    `[${pluginName}] webpackRequire.allow for "${name}" must be an array of package names or module labels.`,
                );
            }
            if (pkg == null || pkg.moduleIds.size === 0) {
                throw new Error(
                    `[${pluginName}] webpackRequire override "${name}" does not match a bundled package.`,
                );
            }
            for (const target of allow) {
                const targetPackage = this.packages.get(target);
                const targetModules = labels.get(target);
                if (targetPackage != null && targetPackage.moduleIds.size > 0) {
                    if (targetPackage !== pkg) {
                        pkg.requirePackages.add(targetPackage.name);
                    }
                } else if (targetModules != null) {
                    for (const id of targetModules) {
                        addToMap(pkg.requireModules, target, id);
                    }
                } else {
                    throw new Error(
                        `[${pluginName}] webpackRequire override for "${name}" targets ${JSON.stringify(target)}, which is neither a bundled package nor a first-party module.`,
                    );
                }
            }
        }
    }
}
