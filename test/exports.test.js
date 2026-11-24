const assert = require("node:assert/strict");
const test = require("node:test");

function exportedNames(moduleName) {
    return Object.keys(require(`../dist/${moduleName}.js`)).sort();
}

test("keeps the package entrypoint API stable", () => {
    assert.deepEqual(exportedNames("index"), ["WardenPlugin"]);
});

test("keeps supported deep module exports stable", () => {
    assert.deepEqual(exportedNames("globals"), [
        "analyzeGlobalAccess",
        "getMkCompartmentSource",
        "mkCompartment",
        "mkCompartmentFactory",
        "rewriteGlobalFunctionBind",
    ]);
    assert.deepEqual(exportedNames("policy-runtime"), [
        "decodePolicyTable",
        "getPolicyRuntimeSource",
        "policyGlobalName",
        "policyRuntimeAssetName",
        "policyRuntimeLoaderMarker",
        "policyRuntimeMarker",
    ]);
    assert.deepEqual(exportedNames("webpack-require"), [
        "createGlobalRequire",
        "createProtectedRequire",
        "getWebpackRequireRuntimeSource",
        "installModuleGuard",
        "webpackRequireDeniedCode",
    ]);
    assert.deepEqual(exportedNames("prototype-freeze"), [
        "getPrototypeFreezeBootstrapSource",
        "prototypeFreezeAssetName",
        "prototypeFreezeBootstrap",
        "prototypeFreezeMarker",
    ]);
});
