const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const webpack = require("webpack");
const { RawSource } = require("webpack-sources");

const { WardenPlugin } = require("../dist/index.js");

class FixtureAssetsPlugin {
    constructor(assets) {
        this.assets = assets;
    }

    apply(compiler) {
        compiler.hooks.thisCompilation.tap("FixtureAssetsPlugin", (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: "FixtureAssetsPlugin",
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE,
                },
                () => {
                    for (const [name, source] of Object.entries(this.assets)) {
                        compilation.emitAsset(name, new RawSource(source));
                    }
                },
            );
        });
    }
}

class FixtureChildCompilerPlugin {
    apply(compiler) {
        compiler.hooks.make.tapAsync(
            "FixtureChildCompilerPlugin",
            (compilation, callback) => {
                const childCompiler = compilation.createChildCompiler(
                    "FixtureChildCompiler",
                    { filename: "child.js" },
                );
                new webpack.EntryPlugin(
                    compiler.context,
                    "./child-entry.js",
                    { name: "child" },
                ).apply(childCompiler);
                childCompiler.runAsChild((error) => callback(error));
            },
        );
    }
}

class UnknownWebpackRequireCapabilityPlugin {
    apply(compiler) {
        compiler.hooks.compilation.tap(
            "UnknownWebpackRequireCapabilityPlugin",
            (compilation) => {
                compilation.hooks.afterCodeGeneration.tap(
                    "UnknownWebpackRequireCapabilityPlugin",
                    () => {
                        for (const runtimeMap of compilation.codeGenerationResults.map.values()) {
                            for (const result of runtimeMap.values()) {
                                if (result.runtimeRequirements == null) {
                                    result.runtimeRequirements = new Set();
                                }
                                result.runtimeRequirements.add(
                                    "__webpack_require__.futureCapability",
                                );
                            }
                        }
                    },
                );
            },
        );
    }
}

async function compile({
    assets = {},
    checkPolicy,
    checkSource,
    dev,
    entryName = "app",
    entrySource = "globalThis.entryRan = true;\n",
    entrySources,
    files = {},
    fixturePackageSource,
    forceCheck,
    freezePrototypes = true,
    mode = "none",
    optimization,
    plugins = [],
    policyOver = {},
    prototypeFreezeMode,
    protectWebpackRequire = true,
    publicPath = "auto",
    webpackConfig = {},
}) {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), "warden-webpack-"));
    const outputPath = path.join(context, "dist");
    const entries = {};
    if (entrySources == null) {
        fs.writeFileSync(path.join(context, "entry.js"), entrySource);
        entries[entryName] = "./entry.js";
    } else {
        for (const [name, source] of Object.entries(entrySources)) {
            const entryFile = `entry-${name}.js`;
            fs.writeFileSync(path.join(context, entryFile), source);
            entries[name] = `./${entryFile}`;
        }
    }
    for (const [file, source] of Object.entries(files)) {
        const outputFile = path.join(context, file);
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, source);
    }
    fs.mkdirSync(path.join(context, "SecSDK"));
    fs.writeFileSync(
        path.join(context, "SecSDK/policy-over.json"),
        `${JSON.stringify(policyOver, null, 2)}\n`,
    );
    if (checkSource !== undefined) {
        fs.writeFileSync(
            path.join(context, "SecSDK/check.json"),
            checkSource,
        );
    } else if (checkPolicy !== undefined) {
        fs.writeFileSync(
            path.join(context, "SecSDK/check.json"),
            `${JSON.stringify(checkPolicy, null, 2)}\n`,
        );
    }
    if (fixturePackageSource != null) {
        const fixturePackagePath = path.join(
            context,
            "node_modules/fixture-policy",
        );
        fs.mkdirSync(fixturePackagePath, { recursive: true });
        fs.writeFileSync(
            path.join(fixturePackagePath, "package.json"),
            JSON.stringify({ main: "index.js", name: "fixture-policy" }),
        );
        fs.writeFileSync(
            path.join(fixturePackagePath, "index.js"),
            fixturePackageSource,
        );
    }

    const pluginOptions = { freezePrototypes, protectWebpackRequire };
    if (dev !== undefined) {
        pluginOptions.dev = dev;
    }
    if (forceCheck !== undefined) {
        pluginOptions.forceCheck = forceCheck;
    }
    if (prototypeFreezeMode !== undefined) {
        pluginOptions.prototypeFreezeMode = prototypeFreezeMode;
    }

    let compiler;
    try {
        compiler = webpack({
            mode,
            context,
            entry: entries,
            output: {
                path: outputPath,
                filename: "[name].js",
                publicPath,
            },
            optimization,
            plugins: [
                new FixtureAssetsPlugin(assets),
                new WardenPlugin(pluginOptions),
                ...plugins,
            ],
            ...webpackConfig,
        });

        const stats = await new Promise((resolve, reject) => {
            compiler.run((error, result) => {
                if (error) {
                    reject(error);
                } else if (result == null) {
                    reject(new Error("Webpack returned no stats"));
                } else {
                    resolve(result);
                }
            });
        });

        if (stats.hasErrors()) {
            throw new Error(
                stats.toString({ all: false, errors: true, errorDetails: true }),
            );
        }

        const result = {};
        for (const asset of stats.compilation.getAssets()) {
            result[asset.name] = fs.readFileSync(
                path.join(outputPath, asset.name),
                "utf8",
            );
        }
        result["SecSDK/policy.json"] = fs.readFileSync(
            path.join(context, "SecSDK/policy.json"),
            "utf8",
        );
        return result;
    } finally {
        if (compiler != null) {
            await new Promise((resolve) => compiler.close(resolve));
        }
        fs.rmSync(context, { recursive: true, force: true });
    }
}

async function compileWithMinifiedChild() {
    const context = fs.mkdtempSync(path.join(os.tmpdir(), "warden-child-webpack-"));
    const outputPath = path.join(context, "dist");
    fs.writeFileSync(path.join(context, "entry.js"), "globalThis.entryRan = true;\n");
    fs.writeFileSync(
        path.join(context, "child-entry.js"),
        "globalThis.childEntryRan = true;\n",
    );

    const compiler = webpack({
        mode: "production",
        context,
        entry: "./entry.js",
        output: {
            path: outputPath,
            filename: "app.js",
        },
        plugins: [
            new FixtureChildCompilerPlugin(),
            new FixtureAssetsPlugin({ "index.html": html }),
            new WardenPlugin(),
        ],
    });

    try {
        const stats = await new Promise((resolve, reject) => {
            compiler.run((error, result) => {
                if (error) {
                    reject(error);
                } else if (result == null) {
                    reject(new Error("Webpack returned no stats"));
                } else {
                    resolve(result);
                }
            });
        });

        if (stats.hasErrors()) {
            throw new Error(
                stats.toString({ all: false, errors: true, errorDetails: true }),
            );
        }

        return fs.readFileSync(
            path.join(outputPath, "warden-prototype-freeze.js"),
            "utf8",
        );
    } finally {
        await new Promise((resolve) => compiler.close(resolve));
        fs.rmSync(context, { recursive: true, force: true });
    }
}

const html = "<!doctype html><html><head><script src=\"existing.js\"></script></head><body></body></html>";

function executeWebpackAssets(assets, entry = "app.js") {
    const context = vm.createContext({ console });
    context.self = context;
    if (assets["warden-prototype-freeze.js"] != null) {
        vm.runInContext(assets["warden-prototype-freeze.js"], context);
    }
    if (assets["warden-policy-runtime.js"] != null) {
        vm.runInContext(assets["warden-policy-runtime.js"], context);
    }
    vm.runInContext(assets[entry], context);
    return context;
}

/** package.json + index.js for a fixture package in node_modules. */
function packageFiles(name, source, extraFiles = {}) {
    const files = {
        [`node_modules/${name}/package.json`]: JSON.stringify({
            main: "index.js",
            name: name.split("/node_modules/").pop(),
        }),
        [`node_modules/${name}/index.js`]: source,
    };
    for (const [file, content] of Object.entries(extraFiles)) {
        files[`node_modules/${name}/${file}`] = content;
    }
    return files;
}

async function captureWarnings(run) {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try {
        await run();
    } finally {
        console.warn = originalWarn;
    }
    return warnings;
}

const denied = (error) => error.code === "WARDEN_WEBPACK_REQUIRE_DENIED";

test("emits a CSP-safe asset and injects HTML and the MV3 worker", async () => {
    const assets = await compile({
        assets: {
            "index.html": html,
            "nested/page.html": html,
            "manifest.json": JSON.stringify({
                manifest_version: 3,
                background: { service_worker: "sw.js" },
                content_scripts: [
                    { matches: ["<all_urls>"], js: ["content.js"] },
                    {
                        matches: ["<all_urls>"],
                        js: ["main-world.js"],
                        world: "MAIN",
                    },
                ],
            }),
            "sw.js": "globalThis.workerRan = true;\n",
            "content.js": "globalThis.contentRan = true;\n",
            "main-world.js": "globalThis.mainWorldRan = true;\n",
            "pageProvider.js": "globalThis.providerRan = true;\n",
        },
    });

    assert.match(
        assets["warden-prototype-freeze.js"],
        /^\/\* warden-prototype-freeze \*\//,
    );
    assert.match(
        assets["warden-policy-runtime.js"],
        /^\/\* warden-policy-runtime \*\//,
    );
    assert.match(
        assets["index.html"],
        /<head>\n<script src="warden-prototype-freeze\.js" data-warden-prototype-freeze><\/script>\n<script src="warden-policy-runtime\.js" data-warden-policy-runtime><\/script><script src="existing\.js">/,
    );
    assert.match(
        assets["nested/page.html"],
        /<head>\n<script src="\.\.\/warden-prototype-freeze\.js" data-warden-prototype-freeze><\/script>\n<script src="\.\.\/warden-policy-runtime\.js" data-warden-policy-runtime><\/script>/,
    );
    assert.equal(
        (assets["index.html"].match(/data-warden-prototype-freeze/g) || []).length,
        1,
    );
    assert.equal(
        (assets["index.html"].match(/data-warden-policy-runtime/g) || []).length,
        1,
    );
    assert.match(assets["sw.js"], /^\/\* warden-prototype-freeze \*\//);
    assert.match(
        assets["sw.js"],
        /\/\* warden-policy-runtime-loader \*\/\nimportScripts\("warden-policy-runtime\.js"\);/,
    );
    assert.ok(
        assets["sw.js"].indexOf("warden-prototype-freeze") <
            assets["sw.js"].indexOf("warden-policy-runtime-loader"),
    );
    assert.match(assets["sw.js"], /globalThis\.workerRan = true/);
    assert.match(assets["content.js"], /^\/\* warden-prototype-freeze \*\//);
    assert.match(assets["content.js"], /globalThis\.contentRan = true/);
    assert.doesNotMatch(assets["main-world.js"], /warden-prototype-freeze/);
    assert.doesNotMatch(assets["pageProvider.js"], /warden-prototype-freeze/);
    assert.doesNotMatch(assets["pageProvider.js"], /warden-policy-runtime/);
});

test("externalizes production policies behind an immutable global", async () => {
    const warnings = [];
    const assets = await compile({
        assets: { "index.html": html },
        dev: false,
        entrySource: 'require("fixture-policy");\n',
        fixturePackageSource: `
            globalThis.fixtureResult =
                globalThis[["missing", "Global"].join("")];
        `,
        mode: "production",
    });

    assert.doesNotMatch(assets["app.js"], /fixture-policy/);
    assert.match(assets["warden-policy-runtime.js"], /"fixture-policy"/);

    const context = vm.createContext({
        console: {
            log() {},
            warn(message) {
                warnings.push(String(message));
            },
        },
    });
    vm.runInContext(assets["warden-prototype-freeze.js"], context);
    vm.runInContext(assets["warden-policy-runtime.js"], context);

    const runtimeState = vm.runInContext(
        `({
            descriptor: Object.getOwnPropertyDescriptor(
                globalThis,
                "__wardenPolicy",
            ),
            frozen: Object.isFrozen(__wardenPolicy),
            makeGlobalIdentifierType: typeof __mkGb,
        })`,
        context,
    );
    assert.equal(runtimeState.descriptor.writable, false);
    assert.equal(runtimeState.descriptor.configurable, false);
    assert.equal(runtimeState.frozen, true);
    assert.equal(runtimeState.makeGlobalIdentifierType, "undefined");

    vm.runInContext(assets["app.js"], context);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missingGlobal/);
    assert.match(warnings[0], /in package "fixture-policy"/);
});

test("does not expose a sandbox factory to external or inline modules", async () => {
    for (const entryName of ["app", "pageProvider"]) {
        for (const protectWebpackRequire of [true, false]) {
            const assets = await compile({
                assets: entryName === "app" ? { "index.html": html } : {},
                dev: false,
                entryName,
                entrySource: 'require("fixture-policy");\n',
                fixturePackageSource: `
                    let callResult;
                    try {
                        const elevated = __mkGb(
                            { document: "rw" },
                            false,
                            "attacker",
                        );
                        callResult = typeof elevated.document;
                    } catch (error) {
                        callResult = error.name;
                    }
                    let interceptorAccess;
                    try {
                        interceptorAccess = typeof __webpack_require__.i;
                    } catch (error) {
                        interceptorAccess = error.code;
                    }
                    globalThis.factoryEscapeAttempt = {
                        bare: typeof __mkGb,
                        callResult,
                        interceptorAccess,
                        property: typeof globalThis.__mkGb,
                    };
                `,
                mode: "production",
                protectWebpackRequire,
            });

            const context = executeWebpackAssets(
                assets,
                `${entryName}.js`,
            );
            assert.deepEqual(
                JSON.parse(JSON.stringify(context.factoryEscapeAttempt)),
                {
                    bare: "undefined",
                    callResult: "ReferenceError",
                    interceptorAccess: protectWebpackRequire
                        ? "WARDEN_WEBPACK_REQUIRE_DENIED"
                        : "undefined",
                    property: "undefined",
                },
            );
            assert.equal(
                Object.getOwnPropertyDescriptor(context, "__mkGb"),
                undefined,
            );
        }
    }
});

test("writes one effective policy entry per package", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        entrySource: 'require("fixture-policy");\n',
        files: {
            "node_modules/fixture-policy/other.js": `
                globalThis.fixtureVisible;
                module.exports = globalThis.otherInput;
            `,
        },
        fixturePackageSource: `
            require("./other");
            globalThis.fixtureVisible = globalThis.fixtureInput;
            const dynamicName = "dynamicFixture";
            globalThis[dynamicName] = true;
        `,
        policyOver: {
            "fixture-policy": {
                global: {
                    allow: { manuallyAllowed: "r" },
                },
            },
        },
    });

    // Modules of one package are merged; "rw" wins over "r".
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "fixture-policy": {
            enable: true,
            global: {
                fixtureInput: "r",
                fixtureVisible: "rw",
                manuallyAllowed: "r",
                otherInput: "r",
            },
        },
    });
});

test("names nested packages by their node_modules chain", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        dev: false,
        entrySource: `
            globalThis.nestedFixture = {
                outer: require("outer"),
                top: require("inner"),
            };
        `,
        files: {
            ...packageFiles(
                "outer",
                `module.exports = [require("inner"), require("@scope/dep")];`,
            ),
            ...packageFiles(
                "outer/node_modules/inner",
                `module.exports = "nested:" + typeof globalThis.nestedOnly;`,
            ),
            ...packageFiles(
                "outer/node_modules/@scope/dep",
                `module.exports = "scoped";`,
            ),
            ...packageFiles(
                "inner",
                `module.exports = "top:" + typeof globalThis.nestedOnly;`,
            ),
        },
        policyOver: {
            "outer > inner": { global: { allow: { extra: "rw" } } },
        },
    });

    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        inner: { enable: true, global: { nestedOnly: "r" } },
        outer: {
            enable: true,
            require: ["outer > @scope/dep", "outer > inner"],
        },
        "outer > inner": {
            enable: true,
            global: { extra: "rw", nestedOnly: "r" },
        },
    });
    const context = executeWebpackAssets(assets);
    assert.deepEqual(JSON.parse(JSON.stringify(context.nestedFixture)), {
        outer: ["nested:undefined", "scoped"],
        top: "top:undefined",
    });
});

test("skips the global check without check.json and accepts any matching rule", async () => {
    const warnings = await captureWarnings(async () => {
        await compile({
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: "globalThis.document;\n",
        });
        await compile({
            checkPolicy: {
                chrome: [],
                document: ["^not-the-fixture$", "^fixture-policy$"],
                fetch: ["policy$"],
            },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: `
                globalThis.document;
                globalThis.fetch;
                const dynamicName = "document";
                globalThis[dynamicName];
            `,
        });
    });

    assert.deepEqual(warnings, []);
});

test("denies globals that check.json does not list", async () => {
    await assert.rejects(
        compile({
            checkPolicy: { document: ["."] },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: `
                globalThis.document;
                globalThis.unlistedGlobal;
            `,
            forceCheck: true,
        }),
        (error) => {
            const message = String(error.message);
            assert.match(message, /Global access check failed/);
            assert.match(
                message,
                /Package "fixture-policy" uses global "unlistedGlobal", which is not listed in "SecSDK\/check\.json"/,
            );
            assert.doesNotMatch(message, /global "document"/);
            return true;
        },
    );
});

test("warns once per final-policy violation by default and when explicitly disabled", async () => {
    const warnings = await captureWarnings(async () => {
        for (const forceCheck of [undefined, false]) {
            const assets = await compile({
                checkPolicy: {
                    document: [],
                    fetch: ["^fixture-policy$"],
                    openToAll: ["."],
                },
                entrySource: 'require("fixture-policy");\n',
                fixturePackageSource: `
                    globalThis.document;
                    globalThis.document;
                    globalThis.fetch;
                    globalThis.openToAll;
                `,
                forceCheck,
            });
            const policy = JSON.parse(assets["SecSDK/policy.json"]);
            assert.deepEqual(policy["fixture-policy"].global, {
                document: "r",
                fetch: "r",
                openToAll: "r",
            });
        }
    });

    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
        assert.match(
            warning,
            /Package "fixture-policy" is not allowed to use global "document"/,
        );
        assert.doesNotMatch(warning, /global "fetch"/);
        assert.doesNotMatch(warning, /openToAll/);
    }
});

test("fails strict builds with a stable deduplicated violation summary", async () => {
    await assert.rejects(
        compile({
            checkPolicy: {
                document: [],
                fetch: [],
            },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: `
                globalThis.fetch;
                globalThis.document;
                globalThis.fetch;
            `,
            forceCheck: true,
        }),
        (error) => {
            const message = String(error.message);
            assert.match(message, /Global access check failed/);
            assert.equal(
                (message.match(/global "document"/g) ?? []).length,
                1,
            );
            assert.equal(
                (message.match(/global "fetch"/g) ?? []).length,
                1,
            );
            assert.ok(
                message.indexOf('global "document"') <
                    message.indexOf('global "fetch"'),
            );
            return true;
        },
    );
});

test("fails global checks by default in production mode", async () => {
    await assert.rejects(
        compile({
            dev: false,
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: "globalThis.document;\n",
            checkPolicy: { document: [] },
        }),
        /Global access check failed/,
    );
});

test("checks packages whose sandbox is disabled", async () => {
    await assert.rejects(
        compile({
            checkPolicy: { document: [] },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: "globalThis.document;\n",
            forceCheck: true,
            policyOver: { "fixture-policy": { enable: false } },
        }),
        /Package "fixture-policy".*global "document"/,
    );
});

test("does not send node_modules JSON resources through JavaScript analysis", async () => {
    const assets = await compile({
        entrySource: `globalThis.jsonFixture = require("fixture-json");`,
        files: {
            "node_modules/fixture-json/package.json": JSON.stringify({
                main: "data.json",
                name: "fixture-json",
            }),
            "node_modules/fixture-json/data.json": JSON.stringify({ ok: true }),
        },
    });
    const context = executeWebpackAssets(assets);
    assert.equal(context.jsonFixture.ok, true);
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {});
});

test("checks final permissions added only by policy-over", async () => {
    await assert.rejects(
        compile({
            checkPolicy: { chrome: [] },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: "module.exports = 42;\n",
            forceCheck: true,
            policyOver: {
                "fixture-policy": {
                    global: { allow: { chrome: "rw" } },
                },
            },
        }),
        /Package "fixture-policy".*global "chrome"/,
    );
});

test("fails the build on a disallowed static global even in discovery mode", async () => {
    for (const accessor of ["fetch", "window.fetch"]) {
        await assert.rejects(
            compile({
                dev: true,
                forceCheck: false,
                checkPolicy: { fetch: ["^fixture-policy$"] },
                policyOver: { "fixture-policy": { global: { disallow: ["fetch"] } } },
                entrySource: 'require("fixture-policy");',
                fixturePackageSource: `module.exports = () => ${accessor}("/");`,
            }),
            /Package "fixture-policy" statically accesses global "fetch".*global\.disallow/,
        );
    }
});

test("blocks disallowed dynamic global access and reflection in discovery mode", async () => {
    const assets = await compile({
        dev: true,
        policyOver: {
            "fixture-policy": { global: { allow: { fetch: "rw" }, disallow: ["fetch"] } },
        },
        checkPolicy: {},
        entrySource: `
            globalThis.fetch = "original";
            globalThis.probe = "discoverable";
            const inspect = require("fixture-policy");
            globalThis.result = inspect("fetch", "probe");
        `,
        fixturePackageSource: `
            module.exports = (name, probe) => [
                globalThis[name],
                name in globalThis,
                Reflect.getOwnPropertyDescriptor(globalThis, name),
                Reflect.ownKeys(globalThis).includes(name),
                Reflect.set(globalThis, name, "changed"),
                Reflect.defineProperty(globalThis, name, { value: "changed" }),
                Reflect.deleteProperty(globalThis, name),
                globalThis[probe],
            ];
        `,
    });
    const context = executeWebpackAssets(assets);
    assert.deepEqual(Array.from(context.result), [
        undefined, false, undefined, false, false, false, false, "discoverable",
    ]);
    assert.equal(context.fetch, "original");
    assert.equal(context.__dbg_ru1n["fixture-policy"].fetch, undefined);
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "fixture-policy": { enable: true, disallow: ["fetch"] },
    });
});

test("rejects malformed disallow rules and sandbox opt-outs", async () => {
    for (const [override, expected] of [
        [{ global: { disallow: "fetch" } }, /global\.disallow.*must be an array/],
        [{ global: { disallow: ["Object"] } }, /global\.disallow cannot target intrinsic/],
        [{ enable: false, global: { disallow: ["fetch"] } }, /requires the strict global sandbox/],
        [{ strict: false, global: { disallow: ["fetch"] } }, /requires the strict global sandbox/],
    ]) {
        await assert.rejects(compile({ policyOver: { "fixture-policy": override } }), expected);
    }
});

test("rejects malformed check.json configurations", async () => {
    const invalidChecks = [
        {
            options: { checkSource: "{not-json" },
            expected: /Cannot parse .*check\.json/,
        },
        {
            options: { checkPolicy: [] },
            expected: /must contain an object/,
        },
        {
            options: { checkPolicy: { fetch: "^antd" } },
            expected: /rules for global "fetch" must be an array/i,
        },
        {
            options: { checkPolicy: { fetch: [42] } },
            expected: /rule 0 for global "fetch" must be a string/i,
        },
        {
            options: { checkPolicy: { fetch: ["["] } },
            expected: /Invalid regular expression .* for global "fetch"/,
        },
    ];

    for (const { options, expected } of invalidChecks) {
        await assert.rejects(compile(options), expected);
    }
});

test("lists required packages and lets a package use its own generated modules", async () => {
    let assets;
    const warnings = await captureWarnings(async () => {
        assets = await compile({
            entrySource: `
                require("./first-party");
                const values = require("fixture-policy");
                globalThis.contextValues = values.keys().map(values);
            `,
            files: {
                "package.json": JSON.stringify({ name: "fixture-project" }),
                "first-party.js": `module.exports = require("fixture-dependency");`,
                ...packageFiles(
                    "fixture-dependency",
                    `module.exports = "dependency";`,
                ),
                "node_modules/fixture-policy/features/a.js": `module.exports = "feature";`,
            },
            fixturePackageSource: `
                require("fixture-dependency");
                require("../../package.json");
                require("fs");
                module.exports = require.context("./features", false, /\\.js$/);
            `,
            webpackConfig: { resolve: { fallback: { fs: false } } },
        });
    });

    // The context module and the ignored "fs" request belong to the package
    // itself; only the root package.json is listed as a first-party module.
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "fixture-policy": {
            enable: true,
            require: ["./package.json", "fixture-dependency"],
        },
    });
    assert.deepEqual(warnings, []);
    const context = executeWebpackAssets(assets);
    assert.deepEqual(Array.from(context.contextValues), ["feature"]);
});

test("warns when third-party packages reference first-party code", async () => {
    const warnings = await captureWarnings(async () => {
        for (const forceCheck of [undefined, false]) {
            await compile({
                entrySource: 'require("fixture-policy");\n',
                files: {
                    "first-party.js": `module.exports = "first-party";`,
                },
                fixturePackageSource: `module.exports = require("../../first-party");`,
                forceCheck,
            });
        }
    });

    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
        assert.match(warning, /Third-party package "fixture-policy"/);
        assert.match(warning, /first-party module "\.\/first-party\.js"/);
    }
});

test("fails strict builds with deduplicated third-party boundary violations", async () => {
    await assert.rejects(
        compile({
            entrySource: 'require("fixture-policy");\n',
            files: {
                "first-party-a.js": `module.exports = "a";`,
                "first-party-b.js": `module.exports = "b";`,
            },
            fixturePackageSource: `
                require("../../first-party-a");
                require("../../first-party-a");
                import("../../first-party-b");
            `,
            forceCheck: true,
        }),
        (error) => {
            const message = String(error.message);
            assert.match(message, /Third-party package boundary check failed/);
            for (const name of ["a", "b"]) {
                assert.equal(
                    message.split(`first-party module "./first-party-${name}.js"`)
                        .length - 1,
                    1,
                );
            }
            return true;
        },
    );
});

test("checks first-party references added by policy-over", async () => {
    await assert.rejects(
        compile({
            entrySource: `
                require("fixture-policy");
                require("./first-party");
            `,
            files: {
                "first-party.js": `module.exports = "first-party";`,
            },
            fixturePackageSource: "module.exports = 42;\n",
            forceCheck: true,
            policyOver: {
                "fixture-policy": {
                    webpackRequire: { allow: ["./first-party.js"] },
                },
            },
        }),
        /Third-party package "fixture-policy".*first-party module "\.\/first-party\.js"/,
    );
});

test("omits packages whose only output field would be enable true", async () => {
    const options = {
        assets: { "index.html": html },
        entrySource: 'require("fixture-policy");\n',
        fixturePackageSource: "module.exports = 42;\n",
        protectWebpackRequire: false,
    };
    const assets = await compile(options);
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {});

    const disabledAssets = await compile({
        ...options,
        policyOver: { "fixture-policy": { enable: false } },
    });
    assert.deepEqual(JSON.parse(disabledAssets["SecSDK/policy.json"]), {
        "fixture-policy": { enable: false },
    });
});

test("leaves first-party modules unprotected and out of the policy", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `
            const victim = require("./victim");
            globalThis.firstPartyFixture = {
                direct: require("./reader")(victim.id),
                sameRequire: require("./reader").require === __webpack_require__,
                interceptors: Array.isArray(__webpack_require__.i),
                // webpack compiles \`global\` to __webpack_require__.g
                realGlobal: global === globalThis,
            };
        `,
        files: {
            // No static dependency on victim.js: only the raw require reaches it.
            "reader.js": `
                module.exports = id => __webpack_require__(id).value;
                module.exports.require = __webpack_require__;
            `,
            "victim.js": `module.exports = { id: module.id, value: "open" };`,
        },
    });

    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {});
    const context = executeWebpackAssets(assets);
    assert.deepEqual(JSON.parse(JSON.stringify(context.firstPartyFixture)), {
        direct: "open",
        sameRequire: true,
        interceptors: true,
        realGlobal: true,
    });
});

test("guards third-party requires and blocks registry and interceptor bypasses", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `
            const attacker = require("attacker");
            const victim = require("./victim");
            const other = require("other-package");
            globalThis.webpackGuardFixture = { attacker, other, victim };
        `,
        files: {
            ...packageFiles(
                "attacker",
                `
                const loadDeclared = () => import(
                    /* webpackMode: "eager" */ "./declared"
                );
                const attacker = function (id, operation) {
                    if (operation === "direct") return __webpack_require__(id);
                    if (operation === "bind") return __webpack_require__.bind(null, id)();
                    if (operation === "namespace") return __webpack_require__.t(id, 1);
                    if (operation === "factories") return __webpack_require__.m[id];
                    if (operation === "cache") return __webpack_require__.c[id];
                    if (operation === "interceptor") return __webpack_require__.i;
                    if (operation === "prototype") return Object.getPrototypeOf(__webpack_require__);
                    if (operation === "prototypeDescriptor") return Object.getOwnPropertyDescriptor(__webpack_require__, "prototype");
                    if (operation === "constructor") return __webpack_require__.constructor;
                    if (operation === "construct") return new __webpack_require__();
                };
                attacker.id = module.id;
                attacker.loadDeclared = loadDeclared;
                module.exports = attacker;
            `,
                { "declared.js": `module.exports = "declared";` },
            ),
            ...packageFiles(
                "other-package",
                `module.exports = { id: module.id, value: "other" };`,
            ),
            "victim.js": `
                module.exports = { id: module.id, value: "secret" };
            `,
        },
    });

    const context = executeWebpackAssets(assets);
    const fixture = context.webpackGuardFixture;
    assert.equal(fixture.victim.value, "secret");
    // Modules of the attacker's own package stay reachable.
    assert.equal((await fixture.attacker.loadDeclared()).default, "declared");
    for (const target of [fixture.victim, fixture.other]) {
        for (const operation of ["direct", "bind", "namespace"]) {
            assert.throws(
                () => fixture.attacker(target.id, operation),
                (error) =>
                    denied(error) &&
                    error.requestedModuleId === target.id &&
                    error.callerPackage === "attacker" &&
                    /Package "attacker" cannot require module/.test(
                        error.message,
                    ),
            );
        }
        for (const operation of ["factories", "cache"]) {
            assert.throws(
                () => fixture.attacker(target.id, operation),
                denied,
            );
        }
    }
    assert.throws(
        () => fixture.attacker(fixture.other.id, "direct"),
        /of package "other-package"/,
    );
    assert.throws(
        () => fixture.attacker(fixture.victim.id, "interceptor"),
        /cannot access webpack require capability "i"/,
    );
    assert.equal(fixture.attacker(fixture.victim.id, "prototype"), null);
    assert.equal(
        fixture.attacker(fixture.victim.id, "prototypeDescriptor"),
        undefined,
    );
    for (const operation of ["constructor", "construct"]) {
        assert.throws(
            () => fixture.attacker(fixture.victim.id, operation),
            denied,
        );
    }

    const policyRuntimeState = vm.runInContext(
        `(() => {
            const { attacker, victim } = globalThis.webpackGuardFixture;
            const descriptor = Object.getOwnPropertyDescriptor(
                globalThis,
                "__wardenPolicy",
            );
            const record = __wardenPolicy.lookup(attacker.id);
            return {
                configurable: descriptor.configurable,
                writable: descriptor.writable,
                name: record.name,
                recordFrozen: Object.isFrozen(record),
                firstParty: __wardenPolicy.lookup(victim.id),
            };
        })()`,
        context,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(policyRuntimeState)), {
        configurable: false,
        writable: false,
        name: "attacker",
        recordFrozen: true,
        firstParty: null,
    });
});

test("allows package dependencies and manual webpack require grants", async () => {
    const base = {
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `
            globalThis.webpackGrantFixture = {
                attacker: require("attacker"),
                declared: require("declared"),
                secret: require("./secret"),
                victim: require("victim-package"),
            };
        `,
        files: {
            ...packageFiles(
                "attacker",
                `module.exports = id => __webpack_require__(id);`,
            ),
            ...packageFiles(
                "declared",
                `module.exports = {
                    id: module.id,
                    value: require("victim-package").value,
                };`,
            ),
            ...packageFiles(
                "victim-package",
                `module.exports = { id: module.id, value: "secret" };`,
            ),
            "secret.js": `module.exports = { id: module.id, value: "first-party" };`,
        },
    };

    const deniedAssets = await compile(base);
    const deniedFixture = executeWebpackAssets(deniedAssets).webpackGrantFixture;
    assert.equal(deniedFixture.declared.value, "secret");
    for (const target of [deniedFixture.victim, deniedFixture.secret]) {
        assert.throws(() => deniedFixture.attacker(target.id), /cannot require/);
    }
    assert.deepEqual(JSON.parse(deniedAssets["SecSDK/policy.json"]), {
        declared: { enable: true, require: ["victim-package"] },
    });

    const policyOver = {
        attacker: {
            webpackRequire: { allow: ["victim-package", "./secret.js"] },
        },
    };
    let allowedAssets;
    await captureWarnings(async () => {
        allowedAssets = await compile({ ...base, policyOver });
    });
    const allowedFixture =
        executeWebpackAssets(allowedAssets).webpackGrantFixture;
    assert.equal(allowedFixture.attacker(allowedFixture.victim.id).value, "secret");
    assert.equal(
        allowedFixture.attacker(allowedFixture.secret.id).value,
        "first-party",
    );
    // A grant covers the named package only.
    assert.throws(
        () => allowedFixture.attacker(allowedFixture.declared.id),
        denied,
    );
    assert.deepEqual(JSON.parse(allowedAssets["SecSDK/policy.json"]).attacker, {
        enable: true,
        require: ["./secret.js", "victim-package"],
    });

    let numericIdAssets;
    await captureWarnings(async () => {
        numericIdAssets = await compile({
            ...base,
            mode: "production",
            optimization: { minimize: false },
            policyOver,
        });
    });
    const numericFixture =
        executeWebpackAssets(numericIdAssets).webpackGrantFixture;
    assert.equal(typeof numericFixture.victim.id, "number");
    assert.equal(
        numericFixture.attacker(numericFixture.victim.id).value,
        "secret",
    );
    assert.throws(
        () => numericFixture.attacker(String(numericFixture.victim.id)),
        denied,
    );
});

test("keeps require protection for packages whose sandbox is disabled", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        entrySource: `
            const victim = require("./victim");
            const fixture = require("fixture-policy");
            globalThis.disabledSandboxFixture = {
                realGlobal: fixture.global === globalThis,
                load: () => fixture.load(victim.id),
            };
        `,
        files: {
            "victim.js": `module.exports = { id: module.id };`,
        },
        fixturePackageSource: `
            module.exports = {
                global: globalThis,
                load: id => __webpack_require__(id),
            };
        `,
        policyOver: { "fixture-policy": { enable: false } },
    });

    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "fixture-policy": { enable: false },
    });
    assert.doesNotMatch(assets["app.js"], /const g = __webpack_require__\.g/);
    const fixture = executeWebpackAssets(assets).disabledSandboxFixture;
    assert.equal(fixture.realGlobal, true);
    assert.throws(() => fixture.load(), denied);
});

test("hides the webpack runtime internals from third-party modules", async () => {
    const base = {
        assets: { "index.html": html },
        publicPath: "",
        entrySource: `
            // Never called: only makes webpack emit its chunk-loading runtime.
            globalThis.loadLazy = () => import("./lazy");
            globalThis.internalsFixture = {
                firstPartyCache: typeof __webpack_module_cache__,
                firstPartyChunks: typeof webpackChunk,
                sandboxed: require("fixture-policy"),
                unsandboxed: require("unsandboxed"),
            };
        `,
        files: {
            "lazy.js": `module.exports = "lazy";`,
            ...packageFiles(
                "unsandboxed",
                `module.exports = typeof __webpack_module_cache__;`,
            ),
        },
        fixturePackageSource: `
            module.exports = {
                cache: typeof __webpack_module_cache__,
                chunks: typeof webpackChunk,
                viaAlias: typeof self.webpackChunk,
            };
        `,
        policyOver: { unsandboxed: { enable: false } },
    };

    let assets;
    const warnings = await captureWarnings(async () => {
        assets = await compile({ ...base, dev: false, forceCheck: false });
    });
    // The bootstrap closure and the chunk-loading global really are there...
    const fixture = executeWebpackAssets(assets).internalsFixture;
    assert.equal(fixture.firstPartyCache, "object");
    assert.equal(fixture.firstPartyChunks, "object");
    // ...but third-party code cannot name them, sandboxed or not.
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.sandboxed)), {
        cache: "undefined",
        chunks: "undefined",
        viaAlias: "undefined",
    });
    assert.equal(fixture.unsandboxed, "undefined");
    // A reference is reported and never becomes a grant.
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        unsandboxed: { enable: false },
    });
    assert.equal(
        warnings.filter((warning) =>
            /references the webpack runtime internal/.test(warning),
        ).length,
        3,
    );

    await assert.rejects(
        compile({ ...base, forceCheck: true }),
        /Webpack runtime isolation check failed[\s\S]*"fixture-policy" references the webpack runtime internal "__webpack_module_cache__"/,
    );
});

test("forces sandboxed modules into strict mode unless a package opts out", async () => {
    const base = {
        assets: { "index.html": html },
        entrySource: `
            const fixture = require("fixture-policy");
            globalThis.strictFixture = {
                thisIsUndefined: fixture.plainCallThis === undefined,
                thisIsRealGlobal: fixture.plainCallThis === globalThis,
                moduleThis: fixture.moduleThis === fixture,
            };
        `,
        // Sloppy CommonJS: a plain call would receive the real global.
        fixturePackageSource: `
            exports.plainCallThis = (function () { return this; })();
            exports.moduleThis = this;
        `,
    };

    const strictAssets = await compile(base);
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(executeWebpackAssets(strictAssets).strictFixture),
        ),
        { thisIsUndefined: true, thisIsRealGlobal: false, moduleThis: true },
    );
    assert.deepEqual(JSON.parse(strictAssets["SecSDK/policy.json"]), {});

    const sloppyAssets = await compile({
        ...base,
        policyOver: { "fixture-policy": { strict: false } },
    });
    assert.deepEqual(
        JSON.parse(
            JSON.stringify(executeWebpackAssets(sloppyAssets).strictFixture),
        ),
        { thisIsUndefined: false, thisIsRealGlobal: true, moduleThis: true },
    );
    // The opt-out is visible in the audited policy.
    assert.deepEqual(JSON.parse(sloppyAssets["SecSDK/policy.json"]), {
        "fixture-policy": { enable: true, strict: false },
    });

    const incompatible = {
        ...base,
        fixturePackageSource: `
            with (exports) { plainCallThis = undefined; }
        `,
    };
    await assert.rejects(
        compile(incompatible),
        /fixture-policy.*cannot run in strict mode.*"strict": false for "fixture-policy"/,
    );
    const optedOut = await compile({
        ...incompatible,
        policyOver: { "fixture-policy": { strict: false } },
    });
    assert.equal(
        executeWebpackAssets(optedOut).strictFixture.thisIsUndefined,
        true,
    );
});

test("routes top, parent and frames through the package sandbox", async () => {
    const warnings = [];
    const assets = await compile({
        assets: { "index.html": html },
        dev: false,
        entrySource: `
            globalThis.top = globalThis.parent = globalThis.frames = globalThis;
            globalThis.allowedGlobal = "allowed";
            globalThis.deniedGlobal = "denied";
            globalThis.aliasFixture = require("fixture-policy");
        `,
        fixturePackageSource: `
            const name = ["denied", "Global"].join("");
            module.exports = {
                topIsSandbox: top === globalThis,
                framesIsSandbox: frames === window,
                staticRead: top.allowedGlobal,
                chained: window.parent.frames.allowedGlobal,
                dynamicRead: String(top[name]),
                dynamicViaFrames: String(frames[name]),
            };
        `,
    });
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "fixture-policy": {
            enable: true,
            global: { allowedGlobal: "r", frames: "r", parent: "r", top: "r" },
        },
    });

    const context = vm.createContext({
        console: { log() {}, warn: (message) => warnings.push(String(message)) },
    });
    vm.runInContext(assets["warden-prototype-freeze.js"], context);
    vm.runInContext(assets["warden-policy-runtime.js"], context);
    vm.runInContext(assets["app.js"], context);
    assert.deepEqual(JSON.parse(JSON.stringify(context.aliasFixture)), {
        topIsSandbox: true,
        framesIsSandbox: true,
        staticRead: "allowed",
        chained: "allowed",
        dynamicRead: "undefined",
        dynamicViaFrames: "undefined",
    });
    assert.equal(warnings.length, 2);
    for (const warning of warnings) {
        assert.match(warning, /"deniedGlobal" is denied by policy/);
    }
});

test("lets third-party modules declare bindings named like the sandbox aliases", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        entrySource: `globalThis.declarationFixture = require("fixture-policy");`,
        fixturePackageSource: `
            const self = 1;
            let window = 2;
            class globalThis {}
            function top() {}
            module.exports = [self, window, typeof globalThis, typeof top];
        `,
    });
    assert.deepEqual(
        Array.from(executeWebpackAssets(assets).declarationFixture),
        [1, 2, "function", "function"],
    );
});

test("rejects invalid, unresolved, and stale policy overrides", async () => {
    const base = {
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `require("fixture-policy");`,
        fixturePackageSource: `module.exports = id => __webpack_require__(id);`,
    };
    const invalid = [
        [
            { "fixture-policy": { webpackRequire: { allow: ["missing"] } } },
            /neither a bundled package nor a first-party module/,
        ],
        [
            { "fixture-policy": { webpackRequire: { allow: "missing" } } },
            /must be an array/,
        ],
        [
            { stale: { webpackRequire: { allow: [] } } },
            /does not match a bundled package/,
        ],
        [
            { "fixture-policy": { webpackRequire: { enable: false } } },
            /Unsupported webpackRequire override field\(s\).*enable/,
        ],
        [
            { "fixture-policy": { global: { allow: { fetch: "x" } } } },
            /global\.allow\.fetch for "fixture-policy" must be "r" or "rw"/,
        ],
        [
            { "node_modules/fixture-policy/index.js": { enable: false } },
            /policies are keyed by package name/,
        ],
        [
            { "fixture-policy": { strict: "no" } },
            /"strict" for "fixture-policy" must be a boolean/,
        ],
    ];
    for (const [policyOver, expected] of invalid) {
        await assert.rejects(compile({ ...base, policyOver }), expected);
    }
});

test("fails the build for an unclassified Webpack runtime helper", async () => {
    await assert.rejects(
        compile({
            assets: { "index.html": html },
            entrySource: 'require("fixture-policy");\n',
            fixturePackageSource: "module.exports = 42;\n",
            freezePrototypes: false,
            plugins: [new UnknownWebpackRequireCapabilityPlugin()],
        }),
        /fixture-policy.*requires unsupported webpack runtime capability "futureCapability"/,
    );
});

test("keeps first-party modules concatenated", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        mode: "production",
        optimization: { minimize: false, concatenateModules: true },
        entrySource: `
            import { answer } from "./concat-a";
            import { base } from "fixture-policy";
            globalThis.concatAnswer = answer + base;
        `,
        files: {
            "concat-a.js": `
                import { value } from "./concat-b";
                export const answer = value + 1;
            `,
            "concat-b.js": `export const value = 41;`,
            "node_modules/fixture-policy/package.json": JSON.stringify({
                name: "fixture-policy",
                main: "index.js",
                sideEffects: false,
            }),
        },
        fixturePackageSource: `export const base = 100;`,
    });

    assert.equal(executeWebpackAssets(assets).concatAnswer, 142);
    assert.doesNotMatch(assets["app.js"], /concat-b\.js\b.*\n.*__webpack_require__\(/);
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {});
});

test("supports dynamic imports and context modules inside a package", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `globalThis.packageFixture = require("fixture-policy");`,
        files: {
            "node_modules/fixture-policy/dynamic-target.js": `export default "dynamic-ok";`,
            "node_modules/fixture-policy/lazy-target.js": `export default "lazy-ok";`,
            "node_modules/fixture-policy/animals/a.js": `module.exports = "a";`,
            "node_modules/fixture-policy/animals/b.js": `module.exports = "b";`,
        },
        fixturePackageSource: `
            require("./animals/a");
            const values = require.context("./animals", false, /\\.js$/);
            const weak = require.context("./animals", false, /a\\.js$/, "weak");
            module.exports = {
                eager: import(
                    /* webpackMode: "eager" */ "./dynamic-target"
                ).then(value => value.default),
                context: values.keys().sort().map(values),
                weak: weak("./a.js"),
            };
        `,
    });

    const fixture = executeWebpackAssets(assets).packageFixture;
    assert.equal(await fixture.eager, "dynamic-ok");
    assert.deepEqual(Array.from(fixture.context), ["a", "b"]);
    assert.equal(fixture.weak, "a");
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {});
});

test("binds lazy third-party chunks without a global sandbox factory", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        entrySource: `
            globalThis.lazyFixturePromise = import("fixture-policy");
        `,
        fixturePackageSource: `
            globalThis.lazyFixtureLoaded = true;
            module.exports = "lazy-ok";
        `,
    });

    const lazyAssets = Object.entries(assets).filter(
        ([file]) =>
            file.endsWith(".js") &&
            ![
                "app.js",
                "warden-policy-runtime.js",
                "warden-prototype-freeze.js",
            ].includes(file),
    );
    assert.ok(lazyAssets.length > 0);
    assert.ok(
        lazyAssets.some(([, source]) =>
            /const g = __webpack_require__\.g/.test(source),
        ),
    );
    for (const [, source] of lazyAssets) {
        assert.doesNotMatch(source, /__mkGb/);
    }
    assert.match(assets["warden-policy-runtime.js"], /"fixture-policy"/);
});

test("composes after Webpack's HMR module execution interceptor", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        plugins: [new webpack.HotModuleReplacementPlugin()],
        publicPath: "",
        entrySource: `
            const dependency = require("./dependency");
            const attacker = require("fixture-policy");
            globalThis.hmrGuardFixture = {
                dependency,
                attacker,
                hot: module.hot != null,
            };
        `,
        files: {
            "dependency.js": `module.exports = { id: module.id, value: "hmr-ok" };`,
            "node_modules/fixture-policy/own.js": `module.exports = "own";`,
        },
        fixturePackageSource: `
            module.exports = id => __webpack_require__(id);
            module.exports.own = require("./own");
            module.exports.hot = module.hot != null;
        `,
    });
    const fixture = executeWebpackAssets(assets).hmrGuardFixture;
    assert.equal(fixture.hot, true);
    assert.equal(fixture.attacker.hot, true);
    assert.equal(fixture.attacker.own, "own");
    assert.equal(fixture.dependency.value, "hmr-ok");
    assert.throws(() => fixture.attacker(fixture.dependency.id), denied);
});

test("merges package requirements across entry runtimes and shared chunks", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        entrySources: {
            background: `require("shared-package");`,
            offscreen: `require("shared-package");`,
            ui: `require("shared-package"); require("ui-only");`,
        },
        files: {
            ...packageFiles(
                "shared-package",
                `module.exports = require("shared-dependency");`,
            ),
            ...packageFiles("shared-dependency", `module.exports = "shared-ok";`),
            ...packageFiles("ui-only", `module.exports = require("shared-dependency");`),
        },
        freezePrototypes: false,
        optimization: {
            splitChunks: {
                cacheGroups: {
                    shared: {
                        chunks: "all",
                        enforce: true,
                        name: "shared",
                        test: /shared-(?:package|dependency)/,
                    },
                },
            },
        },
    });

    for (const entry of ["background.js", "offscreen.js", "ui.js"]) {
        assert.match(assets[entry], /WARDEN_WEBPACK_REQUIRE_DENIED/);
    }
    assert.deepEqual(JSON.parse(assets["SecSDK/policy.json"]), {
        "shared-package": { enable: true, require: ["shared-dependency"] },
        "ui-only": { enable: true, require: ["shared-dependency"] },
    });
});

test("shares one sandbox per package and keeps the runtime global private", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        entrySource: `
            // webpack compiles \`global\` to __webpack_require__.g
            const runtimeGlobalBefore = global === globalThis;
            const first = require("sandbox-a");
            const second = require("sandbox-b");
            globalThis.webpackGlobalIsolation = {
                samePackage: first.main === first.other,
                distinctPackages: first.main !== second,
                runtimeGlobalBefore,
                runtimeGlobalAfter: global === globalThis,
                firstIsRuntimeGlobal: first.main === global,
                secondIsRuntimeGlobal: second === global,
            };
        `,
        files: {
            ...packageFiles(
                "sandbox-a",
                `module.exports = { main: globalThis, other: require("./other") };`,
                { "other.js": `module.exports = globalThis;` },
            ),
            ...packageFiles("sandbox-b", `module.exports = globalThis;`),
        },
    });
    const context = executeWebpackAssets(assets);
    assert.deepEqual(
        JSON.parse(JSON.stringify(context.webpackGlobalIsolation)),
        {
            samePackage: true,
            distinctPackages: true,
            runtimeGlobalBefore: true,
            runtimeGlobalAfter: true,
            firstIsRuntimeGlobal: false,
            secondIsRuntimeGlobal: false,
        },
    );
});

test("keeps third-party ESM packages out of module concatenation", async () => {
    for (const policyOver of [{}, { "sandbox-esm": { enable: false } }]) {
        const sandboxed = policyOver["sandbox-esm"] == null;
        const assets = await compile({
            assets: { "index.html": html },
            entrySource: `
                import { first, second, load } from "sandbox-esm";
                import { id } from "./victim";
                globalThis.concatenationIsolation = {
                    first: first !== globalThis,
                    second: second !== globalThis,
                    load: () => load(id),
                };
            `,
            files: {
                "victim.js": `export const id = module.id;`,
                "node_modules/sandbox-esm/package.json": JSON.stringify({
                    name: "sandbox-esm",
                    main: "index.js",
                }),
                "node_modules/sandbox-esm/index.js": `
                    import { second } from "./second";
                    export const first = globalThis;
                    export const load = id => __webpack_require__(id);
                    export { second };
                `,
                "node_modules/sandbox-esm/second.js": `
                    export const second = globalThis;
                `,
            },
            mode: "production",
            optimization: { concatenateModules: true, minimize: false },
            policyOver,
        });

        const fixture = executeWebpackAssets(assets).concatenationIsolation;
        assert.equal(fixture.first, sandboxed);
        assert.equal(fixture.second, sandboxed);
        assert.throws(() => fixture.load(), denied);
        assert.match(assets["warden-policy-runtime.js"], /"sandbox-esm"/);
    }
});

test("keeps content and pageProvider require policies self-contained", async () => {
    for (const entryName of ["content-script", "pageProvider"]) {
        const assets = await compile({
            entryName,
            freezePrototypes: false,
            entrySource: `globalThis.inlineGuardRan = ${JSON.stringify(entryName)};`,
        });
        assert.match(assets[`${entryName}.js`], /warden-webpack-require/);
        assert.doesNotMatch(assets[`${entryName}.js`], /__wardenPolicy/);
        const context = vm.createContext({ console });
        vm.runInContext(assets[`${entryName}.js`], context);
        assert.equal(context.inlineGuardRan, entryName);
    }
});

test("loads policy runtime without prototype freeze when only require protection is enabled", async () => {
    const assets = await compile({
        assets: {
            "index.html": html,
            "manifest.json": JSON.stringify({
                manifest_version: 3,
                background: { service_worker: "sw.js" },
            }),
            "sw.js": "globalThis.workerRan = true;\n",
        },
        freezePrototypes: false,
    });

    assert.equal(assets["warden-prototype-freeze.js"], undefined);
    assert.match(
        assets["index.html"],
        /<head>\n<script src="warden-policy-runtime\.js" data-warden-policy-runtime><\/script><script src="existing\.js">/,
    );
    assert.doesNotMatch(assets["index.html"], /warden-prototype-freeze/);
    assert.match(
        assets["sw.js"],
        /^\/\* warden-policy-runtime-loader \*\/\nimportScripts\("warden-policy-runtime\.js"\);/,
    );
    assert.doesNotMatch(assets["sw.js"], /warden-prototype-freeze/);
});

test("keeps pageProvider policies and runtime self-contained", async () => {
    const assets = await compile({
        assets: {},
        entryName: "pageProvider",
        entrySource: 'require("fixture-policy");\n',
        fixturePackageSource: "globalThis.providerFixture = true;\n",
    });

    assert.match(assets["pageProvider.js"], /warden-webpack-require/);
    assert.match(assets["pageProvider.js"], /\["fixture-policy",\{/);
    assert.doesNotMatch(assets["pageProvider.js"], /__mkGb|__wardenPolicy/);
    assert.doesNotMatch(assets["warden-policy-runtime.js"], /fixture-policy/);

    for (const withPolicyRuntime of [false, true]) {
        const context = vm.createContext({ console });
        if (withPolicyRuntime) {
            vm.runInContext(assets["warden-policy-runtime.js"], context);
        }
        vm.runInContext(assets["pageProvider.js"], context);
        assert.equal(context.providerFixture, true);
        assert.equal(
            Object.getOwnPropertyDescriptor(context, "__mkGb"),
            undefined,
        );
    }
});

test("ignores inherited hooks in minified child compilations", async () => {
    const freezeAsset = await compileWithMinifiedChild();

    assert.match(freezeAsset, /Failed to lock prototype target/);
});

test("MV2 relies on its background HTML and does not rewrite scripts", async () => {
    const assets = await compile({
        assets: {
            "background.html": html,
            "manifest.json": JSON.stringify({
                manifest_version: 2,
                background: { page: "background.html" },
            }),
            "background.js": "globalThis.backgroundRan = true;\n",
        },
        publicPath: "/",
    });

    assert.match(
        assets["background.html"],
        /<script src="\/warden-prototype-freeze\.js" data-warden-prototype-freeze><\/script>/,
    );
    assert.match(
        assets["background.html"],
        /<script src="\/warden-policy-runtime\.js" data-warden-policy-runtime><\/script>/,
    );
    assert.doesNotMatch(assets["background.js"], /warden-prototype-freeze/);
});

test("keeps the global sandbox self-contained when external features are disabled", async () => {
    const assets = await compile({
        assets: {
            "index.html": html,
            "manifest.json": JSON.stringify({
                manifest_version: 3,
                background: { service_worker: "sw.js" },
            }),
            "sw.js": "globalThis.workerRan = true;\n",
        },
        entrySource: 'require("fixture-policy");\n',
        fixturePackageSource: "globalThis.disabledFixture = true;\n",
        freezePrototypes: false,
        protectWebpackRequire: false,
    });

    assert.equal(assets["warden-prototype-freeze.js"], undefined);
    assert.equal(assets["warden-policy-runtime.js"], undefined);
    assert.equal(assets["index.html"], html);
    assert.equal(assets["sw.js"], "globalThis.workerRan = true;\n");
    assert.match(assets["app.js"], /warden-webpack-require/);
    assert.match(assets["app.js"], /\["fixture-policy",\{/);
    assert.doesNotMatch(assets["app.js"], /__mkGb/);
    assert.doesNotMatch(assets["app.js"], /WARDEN_WEBPACK_REQUIRE_DENIED/);
    const context = executeWebpackAssets(assets);
    assert.equal(context.disabledFixture, true);
    assert.equal(
        Object.getOwnPropertyDescriptor(context, "__mkGb"),
        undefined,
    );
});

test("omits the module runtime when no sandboxed module needs it", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        freezePrototypes: false,
        protectWebpackRequire: false,
    });

    assert.equal(assets["warden-prototype-freeze.js"], undefined);
    assert.equal(assets["warden-policy-runtime.js"], undefined);
    assert.equal(assets["index.html"], html);
    assert.doesNotMatch(assets["app.js"], /warden-webpack-require/);
    assert.doesNotMatch(assets["app.js"], /__mkGb/);
    const context = executeWebpackAssets(assets);
    assert.equal(context.entryRan, true);
});

test("can disable require protection without disabling prototype freeze", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        protectWebpackRequire: false,
    });

    assert.match(
        assets["warden-prototype-freeze.js"],
        /warden-prototype-freeze/,
    );
    assert.match(
        assets["warden-policy-runtime.js"],
        /warden-policy-runtime/,
    );
    assert.doesNotMatch(assets["app.js"], /WARDEN_WEBPACK_REQUIRE_DENIED/);
});

test("emits the configured strict prototype freeze mode", async () => {
    const assets = await compile({
        assets: { "index.html": html },
        prototypeFreezeMode: "strict",
    });
    const context = vm.createContext({});
    vm.runInContext(assets["warden-prototype-freeze.js"], context);

    assert.equal(
        vm.runInContext("Object.isFrozen(Object.prototype)", context),
        true,
    );
});

test("rejects an unknown prototype freeze mode", () => {
    assert.throws(
        () => new WardenPlugin({ prototypeFreezeMode: "unknown" }),
        /prototypeFreezeMode must be "compat" or "strict"/,
    );
});

test("fails compilation when early HTML injection is impossible", async () => {
    await assert.rejects(
        compile({ assets: { "fragment.html": "<div>fragment</div>" } }),
        /missing <head>/,
    );
});

test("fails compilation when an MV3 worker is missing", async () => {
    await assert.rejects(
        compile({
            assets: {
                "index.html": html,
                "manifest.json": JSON.stringify({
                    manifest_version: 3,
                    background: { service_worker: "missing.js" },
                }),
            },
        }),
        /was not emitted/,
    );
});

test("fails compilation when manifest.json is invalid", async () => {
    await assert.rejects(
        compile({
            assets: {
                "index.html": html,
                "manifest.json": "{not-json",
            },
        }),
        /Cannot parse "manifest\.json"/,
    );
});
