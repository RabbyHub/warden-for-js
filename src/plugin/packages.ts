import type { Compilation, Module, NormalModule } from "webpack";
import path = require("node:path");

export const packageSeparator = " > ";

/**
 * Names the npm package a file belongs to. Packages nested through their own
 * `node_modules` are joined with " > ":
 * `node_modules/a/node_modules/@s/b/index.js` -> "a > @s/b".
 * Returns null for files outside `node_modules` (first-party code).
 */
export function getPackageName(filePath: string) {
    const segments = filePath.split(/[\\/]/);
    const names: string[] = [];
    for (let index = 0; index < segments.length - 1; index += 1) {
        if (segments[index] !== "node_modules") {
            continue;
        }
        const name = segments[index + 1]!;
        if (name.startsWith(".")) {
            continue; // store/cache directories such as .pnpm
        }
        const scoped = name.startsWith("@") && index + 2 < segments.length;
        names.push(scoped ? `${name}/${segments[index + 2]}` : name);
        index += scoped ? 2 : 1;
    }
    return names.length > 0 ? names.join(packageSeparator) : null;
}

type MaybeConcatenated = Module & { rootModule?: Module; modules?: Module[] };

/** Source modules merged into one factory by module concatenation. */
export function getInnerModules(module: Module) {
    return (module as MaybeConcatenated).modules ?? [];
}

/**
 * Absolute file system location of a module, or null for modules webpack
 * generated or loaded from a URI. `resource` is the resolved file, so a
 * request cannot make a module claim another package's path.
 */
function getModuleFile(module: Module): string | null {
    const root = (module as MaybeConcatenated).rootModule;
    if (root != null) {
        return getModuleFile(root);
    }
    const resource = (module as NormalModule).resource;
    const location =
        typeof resource === "string"
            ? // drop the query and fragment; webpack escapes literal ?/# as \0
              resource.replace(/(?<!\0)[?#].*$/s, "")
            : module.context;
    return location != null && path.isAbsolute(location) ? location : null;
}

/** Resolves which package owns each module and how modules are labelled. */
export class ModuleOwners {
    private readonly owners = new WeakMap<Module, string | null>();

    constructor(
        private readonly compilation: Compilation,
        private readonly rootDir: string,
    ) {}

    /** Package name of a third-party module, null for first-party code. */
    ownerOf(module: Module): string | null {
        let owner = this.owners.get(module);
        if (owner === undefined) {
            this.owners.set(module, null); // guards against issuer cycles
            const file = getModuleFile(module);
            // Modules without a location (ignored requests, externals, data
            // URIs) act on behalf of the module that pulled them in.
            const issuer =
                file == null
                    ? this.compilation.moduleGraph.getIssuer(module)
                    : null;
            owner =
                file != null
                    ? getPackageName(file)
                    : issuer != null
                      ? this.ownerOf(issuer)
                      : null;
            this.owners.set(module, owner);
        }
        return owner;
    }

    /** Stable `policy.json` name of a module that is not part of a package. */
    labelOf(module: Module) {
        const file = getModuleFile(module);
        if (file == null || (module as NormalModule).resource == null) {
            return `webpack:${module.readableIdentifier(this.compilation.requestShortener)}`;
        }
        const relative = path
            .relative(this.rootDir, file)
            .split(path.sep)
            .join("/");
        return relative.startsWith(".") ? relative : `./${relative}`;
    }
}
