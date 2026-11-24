import type { NormalModule } from "webpack";
import { RawSource } from "webpack-sources";
import { parse } from "@babel/parser";
import generate from "@babel/generator";
import { readFileSync } from "node:fs";
import { analyzeGlobalAccess, rewriteGlobalFunctionBind } from "../globals";
import {
    errorMessage,
    getSourceCode,
    pluginName,
    type GlobalPolicy,
} from "./contracts";

/** Merges detected accesses into `target`; "rw" wins over "r". */
export function mergeGlobalAccess(target: GlobalPolicy, source: GlobalPolicy) {
    for (const [name, mode] of Object.entries(source)) {
        if (mode === "rw" || target[name] == null) {
            target[name] = mode;
        }
    }
}

/**
 * Globals a module touches. The file on disk and the loader output are both
 * analyzed and unioned, so a loader cannot hide an access from the policy.
 */
export function analyzeModuleGlobals(module: NormalModule): GlobalPolicy {
    const sources = new Set<string>();
    try {
        sources.add(readFileSync(module.resource, "utf-8"));
    } catch {
        // Virtual resources only have a loader output.
    }
    const original = module.originalSource();
    const loaded = original == null ? null : getSourceCode(original);
    if (loaded != null) {
        sources.add(loaded);
    }

    const access: GlobalPolicy = Object.create(null);
    const errors: string[] = [];
    let parsed = 0;
    for (const code of sources) {
        try {
            mergeGlobalAccess(
                access,
                analyzeGlobalAccess(parse(code, { sourceType: "unambiguous" })),
            );
            parsed += 1;
        } catch (error) {
            errors.push(errorMessage(error));
        }
    }
    if (parsed === 0) {
        throw new Error(
            `[${pluginName}] Cannot parse any source representation for ${JSON.stringify(module.resource)}; refusing to generate an empty global policy: ${errors.join(" | ")}`,
        );
    }
    return access;
}

/**
 * Host functions must not be bound to the sandbox Proxy
 * (`setTimeout.bind(window)`), so such receivers are rewritten to undefined.
 */
export function rewriteGlobalBinds<T extends { source: () => unknown }>(
    source: T,
    resource: string,
): T | RawSource {
    const code = getSourceCode(source);
    if (
        code == null ||
        !code.includes("bind") ||
        !/window|globalThis|self|top|parent|frames/.test(code)
    ) {
        return source;
    }
    try {
        const ast = parse(code, {
            allowReturnOutsideFunction: true,
            sourceType: "unambiguous",
        });
        return rewriteGlobalFunctionBind(ast)
            ? new RawSource(generate(ast, { comments: true }).code)
            : source;
    } catch (error) {
        throw new Error(
            `[${pluginName}] Cannot parse rendered module ${JSON.stringify(resource)} for global bind rewriting: ${errorMessage(error)}`,
        );
    }
}

/**
 * Sandboxed modules are rendered as strict-mode code so that a plain function
 * call cannot receive the real global object as `this`. Returns the reason a
 * sloppy module cannot be parsed that way, or null when it can.
 */
export function getStrictModeError(module: NormalModule): string | null {
    const original = module.originalSource();
    const code = original == null ? null : getSourceCode(original);
    if (code == null) {
        return null;
    }
    try {
        parse(code, { sourceType: "script", strictMode: true });
        return null;
    } catch (error) {
        return errorMessage(error);
    }
}
