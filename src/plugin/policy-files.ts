import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path = require("node:path");
import {
    errorMessage,
    pluginName,
    type OutputPackagePolicy,
    type PolicyOverride,
    type WardenPluginConfig,
} from "./contracts";

const checkFile = "SecSDK/check.json";

/** Global name -> patterns of the package names allowed to use it. */
export type GlobalAllowlist = Map<string, RegExp[]>;
type OutputPolicy = Record<string, OutputPackagePolicy>;

/** Reads and writes the policy files stored next to the project. */
export class PolicyFiles {
    constructor(
        private readonly rootDir: string,
        private readonly config: WardenPluginConfig,
    ) {}

    readPolicyOver(): Record<string, PolicyOverride> {
        try {
            return JSON.parse(
                readFileSync(this.resolve(this.config.policyOverPath), "utf-8"),
            );
        } catch (error) {
            if (this.config.dev) {
                return {};
            }
            throw error;
        }
    }

    /** Returns null when the project has no `check.json` (check disabled). */
    readGlobalAllowlist(): GlobalAllowlist | null {
        const checkPath = this.resolve(checkFile);
        const quoted = JSON.stringify(checkPath);
        let value: unknown;
        try {
            value = JSON.parse(readFileSync(checkPath, "utf-8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return null;
            }
            const action = error instanceof SyntaxError ? "parse" : "read";
            throw new Error(
                `[${pluginName}] Cannot ${action} ${quoted}: ${errorMessage(error)}`,
            );
        }
        if (value == null || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(
                `[${pluginName}] ${quoted} must contain an object mapping global names to regular expression arrays.`,
            );
        }

        const checks: GlobalAllowlist = new Map();
        for (const [globalName, patterns] of Object.entries(value)) {
            const quotedGlobal = JSON.stringify(globalName);
            if (!Array.isArray(patterns)) {
                throw new Error(
                    `[${pluginName}] Check rules for global ${quotedGlobal} must be an array.`,
                );
            }
            checks.set(
                globalName,
                patterns.map((pattern, index) => {
                    if (typeof pattern !== "string") {
                        throw new Error(
                            `[${pluginName}] Check rule ${index} for global ${quotedGlobal} must be a string.`,
                        );
                    }
                    try {
                        return new RegExp(pattern);
                    } catch (error) {
                        throw new Error(
                            `[${pluginName}] Invalid regular expression ${JSON.stringify(pattern)} for global ${quotedGlobal}: ${errorMessage(error)}`,
                        );
                    }
                }),
            );
        }
        return checks;
    }

    /**
     * Default deny: every global a package ends up with must be listed in
     * `check.json` with a pattern matching that package.
     */
    checkGlobals(policy: OutputPolicy, allowlist: GlobalAllowlist | null) {
        if (allowlist == null) {
            return;
        }
        const violations: string[] = [];
        for (const [packageName, { global = {} }] of Object.entries(policy)) {
            for (const globalName of Object.keys(global)) {
                const allowed = allowlist.get(globalName);
                const subject = `Package ${JSON.stringify(packageName)}`;
                const object = `global ${JSON.stringify(globalName)}`;
                if (allowed == null) {
                    violations.push(
                        `${subject} uses ${object}, which is not listed in "${checkFile}".`,
                    );
                } else if (!allowed.some((pattern) => pattern.test(packageName))) {
                    violations.push(
                        `${subject} is not allowed to use ${object} by "${checkFile}".`,
                    );
                }
            }
        }
        this.report("Global access check failed", violations);
    }

    /** Third-party packages must not reach back into first-party code. */
    checkPackageBoundaries(policy: OutputPolicy) {
        const violations: string[] = [];
        for (const [packageName, { require = [] }] of Object.entries(policy)) {
            for (const target of require) {
                // First-party modules are listed by relative path; package
                // metadata is the only harmless one.
                if (
                    target.startsWith(".") &&
                    path.posix.basename(target) !== "package.json"
                ) {
                    violations.push(
                        `Third-party package ${JSON.stringify(packageName)} is not allowed to reference first-party module ${JSON.stringify(target)}.`,
                    );
                }
            }
        }
        this.report("Third-party package boundary check failed", violations);
    }

    writePolicyFile(policy: OutputPolicy) {
        const outputPath = this.resolve(this.config.policyOutputPath);
        const content = `${JSON.stringify(policy, null, 2)}\n`;
        try {
            if (readFileSync(outputPath, "utf-8") === content) {
                return;
            }
        } catch {
            // Missing files are created below.
        }
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, content);
    }

    /** Fails the build under `forceCheck`, warns otherwise. */
    report(title: string, violations: readonly string[]) {
        if (violations.length === 0) {
            return;
        }
        const messages = violations.map(
            (violation) => `[${pluginName}] ${violation}`,
        );
        if (this.config.forceCheck) {
            throw new Error(
                `[${pluginName}] ${title}:\n${messages.map((message) => `- ${message}`).join("\n")}`,
            );
        }
        for (const message of messages) {
            console.warn(message);
        }
    }

    private resolve(filePath: string) {
        return path.resolve(this.rootDir, filePath);
    }
}
