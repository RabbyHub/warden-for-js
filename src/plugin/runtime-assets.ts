import type { Chunk, Compilation } from "webpack";
import { ConcatSource, RawSource } from "webpack-sources";
import path = require("node:path");
import {
    getPrototypeFreezeBootstrapSource,
    prototypeFreezeAssetName,
    prototypeFreezeMarker,
} from "../prototype-freeze";
import {
    getPolicyRuntimeSource,
    policyRuntimeAssetName,
    policyRuntimeLoaderMarker,
    policyRuntimeMarker,
    type PolicyTable,
} from "../policy-runtime";
import {
    errorMessage,
    getSourceCode,
    pluginName,
    type WardenPluginConfig,
} from "./contracts";

// These entries run inside web pages, where a shared policy asset cannot be
// loaded first, so their policy is inlined into their own runtime.
const inlinePolicyRuntimes = new Set(["content-script", "pageProvider"]);

function fail(message: string): never {
    throw new Error(`[${pluginName}] ${message}`);
}

const escapeHtmlAttribute = (value: string) =>
    value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");

/** Emits Warden's runtime assets and wires them into pages and workers. */
export class RuntimeAssets {
    private readonly freezeSource: string;

    constructor(private readonly config: WardenPluginConfig) {
        this.freezeSource = config.freezePrototypes
            ? getPrototypeFreezeBootstrapSource(config.prototypeFreezeMode)
            : "";
    }

    /** Whether pages and workers load the shared policy asset. */
    get usesPolicyAsset() {
        return this.config.freezePrototypes || this.config.protectWebpackRequire;
    }

    /** Whether a runtime chunk reads its policy from the shared asset. */
    usesSharedPolicy(chunk: Chunk) {
        if (!this.usesPolicyAsset) {
            return false;
        }
        const runtime = chunk.runtime;
        const names = [
            chunk.name,
            ...(typeof runtime === "string" ? [runtime] : (runtime ?? [])),
        ];
        return !names.some((name) => inlinePolicyRuntimes.has(String(name)));
    }

    emit(compilation: Compilation, table: PolicyTable) {
        if (this.config.freezePrototypes) {
            this.emitAsset(
                compilation,
                prototypeFreezeAssetName,
                this.freezeSource,
                prototypeFreezeMarker,
            );
        }
        if (this.usesPolicyAsset) {
            this.emitAsset(
                compilation,
                policyRuntimeAssetName,
                getPolicyRuntimeSource(table),
                policyRuntimeMarker,
            );
        }
    }

    /** Makes every page and worker load the emitted assets first. */
    inject(compilation: Compilation) {
        if (!this.usesPolicyAsset) {
            return;
        }
        for (const { name } of compilation.getAssets()) {
            if (name.toLowerCase().endsWith(".html")) {
                this.injectIntoHtml(compilation, name);
            } else if (
                path.posix.basename(name).toLowerCase() === "manifest.json"
            ) {
                this.injectIntoManifestScripts(compilation, name);
            }
        }
    }

    private emitAsset(
        compilation: Compilation,
        name: string,
        source: string,
        marker: string,
    ) {
        const existing = compilation.getAsset(name);
        if (existing == null) {
            compilation.emitAsset(name, new RawSource(source));
        } else if (!getSourceCode(existing.source)?.includes(marker)) {
            fail(`Asset "${name}" already exists with different content.`);
        }
    }

    private readText(compilation: Compilation, file: string, kind: string) {
        const asset = compilation.getAsset(file);
        const text = asset == null ? null : getSourceCode(asset.source);
        return text ?? fail(`${kind} asset "${file}" is not text.`);
    }

    private injectIntoHtml(compilation: Compilation, file: string) {
        const html = this.readText(compilation, file, "HTML");
        const hasFreeze = html.includes(`data-${prototypeFreezeMarker}`);
        const hasPolicy = html.includes(`data-${policyRuntimeMarker}`);
        if (hasPolicy && (hasFreeze || !this.config.freezePrototypes)) {
            return;
        }
        if (hasFreeze || hasPolicy) {
            fail(
                `Cannot inject security runtime into "${file}": incomplete existing Warden script set.`,
            );
        }
        const head = /<head(?:\s[^>]*)?>/i.exec(html);
        if (head == null) {
            return fail(
                `Cannot inject security runtime into "${file}": missing <head>.`,
            );
        }

        const publicPath = compilation.outputOptions.publicPath;
        const urlOf = (assetName: string) =>
            typeof publicPath === "string" &&
            publicPath.length > 0 &&
            publicPath !== "auto"
                ? `${publicPath.replace(/\/?$/, "/")}${assetName}`
                : path.posix.relative(path.posix.dirname(file), assetName);
        const script = (assetName: string, marker: string) =>
            `<script src="${escapeHtmlAttribute(urlOf(assetName))}" data-${marker}></script>`;
        const scripts = [
            ...(this.config.freezePrototypes
                ? [script(prototypeFreezeAssetName, prototypeFreezeMarker)]
                : []),
            script(policyRuntimeAssetName, policyRuntimeMarker),
        ];
        const insertAt = head.index + head[0].length;
        compilation.updateAsset(
            file,
            new RawSource(
                `${html.slice(0, insertAt)}\n${scripts.join("\n")}${html.slice(insertAt)}`,
            ),
        );
    }

    private injectIntoManifestScripts(
        compilation: Compilation,
        manifestFile: string,
    ) {
        let manifest: any;
        try {
            manifest = JSON.parse(
                this.readText(compilation, manifestFile, "Manifest"),
            );
        } catch (error) {
            fail(`Cannot parse "${manifestFile}": ${errorMessage(error)}`);
        }
        const resolve = (assetPath: string) =>
            this.resolveManifestAsset(manifestFile, assetPath);

        if (this.config.freezePrototypes) {
            this.freezeIsolatedContentScripts(compilation, manifest, resolve);
        }

        const worker = manifest?.background?.service_worker;
        if (typeof worker !== "string" || worker.length === 0) {
            return;
        }
        const workerFile = resolve(worker);
        const asset = compilation.getAsset(workerFile);
        if (asset == null) {
            return fail(
                `Service worker "${worker}" declared by "${manifestFile}" was not emitted as "${workerFile}".`,
            );
        }
        const source = getSourceCode(asset.source) ?? "";
        const hasFreeze = source.includes(prototypeFreezeMarker);
        const hasPolicy = source.includes(policyRuntimeLoaderMarker);
        if (hasPolicy && (hasFreeze || !this.config.freezePrototypes)) {
            return;
        }
        if (hasFreeze || hasPolicy) {
            fail(
                `Service worker "${workerFile}" has an incomplete existing Warden runtime prefix.`,
            );
        }
        const policyPath = path.posix.relative(
            path.posix.dirname(workerFile),
            policyRuntimeAssetName,
        );
        compilation.updateAsset(
            workerFile,
            new ConcatSource(
                this.freezeSource,
                `/* ${policyRuntimeLoaderMarker} */\nimportScripts(${JSON.stringify(policyPath)});\n`,
                asset.source,
            ),
        );
    }

    /**
     * Isolated-world content scripts freeze their own realm. Scripts that
     * also run in the page's MAIN world are left alone so the page keeps its
     * prototypes.
     */
    private freezeIsolatedContentScripts(
        compilation: Compilation,
        manifest: any,
        resolve: (assetPath: string) => string,
    ) {
        const entries: unknown = manifest?.content_scripts;
        const isolated = new Set<string>();
        const main = new Set<string>();
        for (const entry of Array.isArray(entries) ? entries : []) {
            for (const script of Array.isArray(entry?.js) ? entry.js : []) {
                if (typeof script === "string" && script.length > 0) {
                    (entry.world === "MAIN" ? main : isolated).add(
                        resolve(script),
                    );
                }
            }
        }

        for (const file of isolated) {
            if (main.has(file)) {
                continue;
            }
            const asset = compilation.getAsset(file);
            if (asset == null) {
                return fail(
                    `Content script ${JSON.stringify(file)} was not emitted.`,
                );
            }
            const source = getSourceCode(asset.source);
            if (source?.startsWith(this.freezeSource)) {
                continue;
            }
            if (source?.includes(prototypeFreezeMarker)) {
                fail(
                    `Content script ${JSON.stringify(file)} contains a misplaced Warden prototype bootstrap.`,
                );
            }
            compilation.updateAsset(
                file,
                new ConcatSource(this.freezeSource, asset.source),
            );
        }
    }

    private resolveManifestAsset(manifestFile: string, assetPath: string) {
        const normalized = assetPath.replaceAll("\\", "/");
        if (/[?#]/.test(normalized)) {
            fail(`Invalid script path "${assetPath}" in "${manifestFile}".`);
        }
        const resolved = path.posix.join(
            path.posix.dirname(manifestFile),
            normalized.replace(/^\/+/, ""),
        );
        if (resolved === ".." || resolved.startsWith("../")) {
            fail(
                `Script path "${assetPath}" escapes the output in "${manifestFile}".`,
            );
        }
        return resolved;
    }
}
