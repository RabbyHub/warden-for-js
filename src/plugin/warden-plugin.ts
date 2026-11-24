import type { Compiler, Module, NormalModule } from "webpack";
import { ConcatSource } from "webpack-sources";
import { realpathSync } from "node:fs";
import type { WebpackModuleId } from "../policy-runtime";
import { getWebpackRequireRuntimeSource } from "../webpack-require";
import {
    normalizePluginOptions,
    pluginName,
    type WardenPluginConfig,
    type WardenPluginOptions,
} from "./contracts";
import { windowAliases } from "../global/capabilities";
import {
    analyzeModuleGlobals,
    getStrictModeError,
    rewriteGlobalBinds,
} from "./global-analysis";
import { PackagePolicies } from "./package-policy";
import { PolicyFiles } from "./policy-files";
import { RuntimeAssets } from "./runtime-assets";

const isJavascriptSource = (module: Module): module is NormalModule =>
    typeof (module as NormalModule).resource === "string" &&
    module.type.startsWith("javascript");

export class WardenPlugin {
    private readonly config: WardenPluginConfig;

    constructor(options: WardenPluginOptions = {}) {
        this.config = normalizePluginOptions(options);
    }

    apply(compiler: Compiler) {
        const { config } = this;
        const rootDir = realpathSync(compiler.context);
        const policyFiles = new PolicyFiles(rootDir, config);
        const runtimeAssets = new RuntimeAssets(config);
        const policyOver = policyFiles.readPolicyOver();
        const globalAllowlist = policyFiles.readGlobalAllowlist();
        const { Compilation, RuntimeGlobals, RuntimeModule, javascript } =
            compiler.webpack;

        compiler.hooks.compilation.tap(pluginName, (compilation) => {
            // Child compilers (e.g. HtmlWebpackPlugin templates) inherit
            // these hooks but must not emit or rewrite Warden's assets.
            if (compilation.compiler !== compiler) {
                return;
            }

            // Names the webpack runtime exposes to module code: the module
            // cache is a closure variable of the bootstrap, the chunk-loading
            // globals pass the unguarded require to whoever pushes a chunk.
            const { chunkLoadingGlobal, hotUpdateGlobal } =
                compilation.outputOptions;
            const internalGlobals = [
                "__webpack_module_cache__",
                chunkLoadingGlobal,
                hotUpdateGlobal,
            ].filter(
                (name): name is string =>
                    typeof name === "string" && /^[A-Za-z_$][\w$]*$/.test(name),
            );
            const policies = new PackagePolicies(
                compilation,
                rootDir,
                config,
                policyOver,
                internalGlobals,
            );
            /** Window aliases each sandboxed module refers to. */
            const moduleAliases = new WeakMap<Module, string[]>();
            /** Package of a third-party JavaScript module, else null. */
            const thirdPartyPackage = (module: Module) =>
                isJavascriptSource(module)
                    ? policies.owners.ownerOf(module)
                    : null;
            const isSandboxed = (module: Module) => {
                const owner = thirdPartyPackage(module);
                return owner != null && policies.isSandboxed(owner);
            };
            let hasSandboxedModules = false;

            // Each third-party module must stay its own factory so that a
            // factory maps to exactly one package policy.
            compilation.hooks.succeedModule.tap(pluginName, (module) => {
                const owner = thirdPartyPackage(module);
                if (
                    owner != null &&
                    (config.protectWebpackRequire || policies.isSandboxed(owner))
                ) {
                    module.buildInfo ??= {};
                    module.buildInfo.moduleConcatenationBailout ??=
                        "Warden per-package policy isolation";
                }
            });

            compilation.hooks.finishModules.tap(pluginName, (modules) => {
                for (const module of modules) {
                    const owner = thirdPartyPackage(module);
                    if (owner == null) {
                        continue;
                    }
                    const globals = analyzeModuleGlobals(module as NormalModule);
                    policies.recordModuleGlobals(module, globals);
                    if (!policies.isSandboxed(owner)) {
                        continue;
                    }
                    hasSandboxedModules = true;
                    moduleAliases.set(
                        module,
                        windowAliases.filter((name) => globals[name] != null),
                    );
                    if (policies.isStrict(owner) && !module.buildInfo?.strict) {
                        const error = getStrictModeError(module as NormalModule);
                        if (error != null) {
                            throw new Error(
                                `[${pluginName}] ${JSON.stringify((module as NormalModule).resource)} cannot run in strict mode (${error}). Sandboxed packages are forced into strict mode; set "strict": false for ${JSON.stringify(owner)} in policy-over.json to opt out.`,
                            );
                        }
                    }
                }
            });

            // Sandboxed factories read their global from __webpack_require__.
            compilation.hooks.additionalModuleRuntimeRequirements.tap(
                pluginName,
                (module, requirements) => {
                    if (isSandboxed(module)) {
                        requirements.add(RuntimeGlobals.require);
                    }
                },
            );

            // Third-party module code runs two functions deep:
            // - the outer parameters shadow the global aliases with the
            //   package sandbox and hide the webpack runtime internals;
            // - the inner function gives the module its own scope, so its
            //   declarations cannot collide with those parameters, and makes
            //   sandboxed code strict so `this` is never the real global.
            javascript.JavascriptModulesPlugin.getCompilationHooks(
                compilation,
            ).renderModuleContent.tap(pluginName, (source, module) => {
                const owner = thirdPartyPackage(module);
                if (owner == null) {
                    return source;
                }
                const sandboxed = policies.isSandboxed(owner);
                if (!sandboxed && !config.protectWebpackRequire) {
                    return source;
                }
                const aliases = sandboxed ? moduleAliases.get(module) ?? [] : [];
                const params = [
                    ...(sandboxed ? ["globalThis", "window", "self"] : []),
                    ...aliases,
                    ...internalGlobals,
                ];
                const args = sandboxed
                    ? ["g", "g", "g", ...aliases.map((name) => `g.${name}`)]
                    : [];
                return new ConcatSource(
                    sandboxed ? "const g = __webpack_require__.g;\n" : "",
                    `((${params.join(", ")}) => (() => {`,
                    policies.isStrict(owner) ? '"use strict";' : "",
                    sandboxed
                        ? rewriteGlobalBinds(
                              source,
                              (module as NormalModule).resource,
                          )
                        : source,
                    `\n})())(${args.join(", ")});`,
                );
            });

            compilation.hooks.additionalTreeRuntimeRequirements.tap(
                pluginName,
                (chunk, requirements) => {
                    if (!config.protectWebpackRequire && !hasSandboxedModules) {
                        return;
                    }
                    requirements.add(RuntimeGlobals.interceptModuleExecution);
                    const shared = runtimeAssets.usesSharedPolicy(chunk);
                    // Runs after webpack's own interceptors (HMR) so the
                    // guard wraps whatever require they hand out.
                    const runtimeModule = new RuntimeModule(
                        "warden module guard",
                        RuntimeModule.STAGE_TRIGGER + 10,
                    );
                    runtimeModule.generate = () =>
                        getWebpackRequireRuntimeSource({
                            ...(shared
                                ? {}
                                : {
                                      table: policies.getTable(
                                          policies.getRuntimeModuleIds(chunk),
                                      ),
                                  }),
                            dev: config.dev,
                            protectRequire: config.protectWebpackRequire,
                        });
                    compilation.addRuntimeModule(chunk, runtimeModule);
                },
            );

            compilation.hooks.processAssets.tap(
                {
                    name: pluginName,
                    stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
                },
                () => {
                    const outputPolicy = policies.getOutputPolicy();
                    policyFiles.report(
                        "Webpack runtime isolation check failed",
                        policies.getViolations(),
                    );
                    policyFiles.checkPackageBoundaries(outputPolicy);
                    policyFiles.checkGlobals(outputPolicy, globalAllowlist);
                    // The shared asset serves every runtime that does not
                    // inline its own policy.
                    const sharedModuleIds = new Set<WebpackModuleId>();
                    for (const chunk of compilation.chunks) {
                        if (
                            chunk.hasRuntime() &&
                            runtimeAssets.usesSharedPolicy(chunk)
                        ) {
                            for (const id of policies.getRuntimeModuleIds(chunk)) {
                                sharedModuleIds.add(id);
                            }
                        }
                    }
                    runtimeAssets.emit(
                        compilation,
                        policies.getTable(sharedModuleIds),
                    );
                    policyFiles.writePolicyFile(outputPolicy);
                },
            );

            // Late enough for HTML and manifest assets to exist.
            compilation.hooks.processAssets.tap(
                {
                    name: `${pluginName}:inject`,
                    stage: Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE,
                },
                () => runtimeAssets.inject(compilation),
            );
        });
    }
}
