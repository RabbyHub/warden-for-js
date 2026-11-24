import * as t from "@babel/types";
import traverse, { NodePath } from "@babel/traverse";
import { ECMAGlobals, windowAliases } from "./capabilities";
import type { GlobalAccessMode } from "./types";

const ecmaGlobals = new Set(ECMAGlobals);
const windowAlias = new Set(windowAliases);

export function analyzeGlobalAccess(
    ast: t.File,
): Record<string, GlobalAccessMode> {
    const globals: Record<string, GlobalAccessMode> = Object.create(null);
    const add = (name: string, perm: GlobalAccessMode) => {
        // 不管控除eval以外的ECMA全局变量的读权限
        if (ecmaGlobals.has(name) && perm === "r") {
            return;
        }
        if (perm === "rw" || globals[name] == null) {
            globals[name] = perm;
        }
    };
    const globalAlias = ["globalThis", "self", "window"];
    const skipName = new Set([
        "__webpack_require__",
        "module",
        "exports",
        "__unused_webpack___webpack_module__",
        "__webpack_exports__",
        "arguments",
        "require",
    ]);

    function parseMemberExpression(node: t.MemberExpression) {
        let expr: string[] = [];
        let flag = true;
        while (t.isMemberExpression(node)) {
            if (t.isIdentifier(node.property) && !node.computed) {
                expr.unshift(node.property.name);
            } else if (t.isStringLiteral(node.property)) {
                expr.unshift(node.property.value);
            } else {
                flag = false;
                break;
            }

            if (t.isIdentifier(node.object)) {
                expr.unshift(node.object.name);
                break;
            } else if (t.isMemberExpression(node.object)) {
                node = node.object;
            } else {
                flag = false;
                break;
            }
        }

        if (!flag) {
            return [];
        }
        return expr;
    }

    function getGlobalIdentifierPerm(path: NodePath<t.Identifier>) {
        const parentPath = path.parentPath;

        if (
            parentPath.isAssignmentExpression() &&
            parentPath.node.left === path.node
        ) {
            return "rw" as const;
        }

        if (
            parentPath.isUpdateExpression() &&
            parentPath.node.argument === path.node
        ) {
            return "rw" as const;
        }

        if (
            parentPath.isUnaryExpression({ operator: "delete" }) &&
            parentPath.node.argument === path.node
        ) {
            return "rw" as const;
        }

        if (
            parentPath.isForInStatement() &&
            parentPath.node.left === path.node
        ) {
            return "rw" as const;
        }

        if (
            parentPath.isForOfStatement() &&
            parentPath.node.left === path.node
        ) {
            return "rw" as const;
        }

        if (isAssignmentPatternTarget(path)) {
            return "rw" as const;
        }

        if (path.isReferencedIdentifier()) {
            return "r" as const;
        }

        return null;
    }

    function isAssignmentPatternTarget(path: NodePath<t.Identifier>) {
        let current: NodePath<t.Node> | null = path.parentPath;

        while (current != null) {
            if (current.isObjectProperty()) {
                if (
                    current.node.key === path.node &&
                    current.node.value !== path.node
                ) {
                    return false;
                }
                current = current.parentPath;
                continue;
            }

            if (current.isAssignmentPattern()) {
                if (current.node.right === path.node) {
                    return false;
                }
                current = current.parentPath;
                continue;
            }

            if (current.isRestElement()) {
                current = current.parentPath;
                continue;
            }

            if (current.isObjectPattern() || current.isArrayPattern()) {
                const parent = current.parentPath;
                return (
                    (parent.isAssignmentExpression() &&
                        parent.node.left === current.node) ||
                    (parent.isForInStatement() &&
                        parent.node.left === current.node) ||
                    (parent.isForOfStatement() &&
                        parent.node.left === current.node)
                );
            }

            return false;
        }

        return false;
    }

    function isGlobalObjectPath(path: NodePath<t.Node>) {
        if (path.isIdentifier()) {
            return (
                (globalAlias.includes(path.node.name) ||
                    windowAlias.has(path.node.name)) &&
                !path.scope.hasBinding(path.node.name, { noGlobals: true })
            );
        }
        if (!path.isMemberExpression()) {
            return false;
        }
        return (
            t.isIdentifier(path.node.object, {
                name: "__webpack_require__",
            }) &&
            t.isIdentifier(path.node.property, { name: "g" }) &&
            !path.node.computed
        );
    }

    function addReflectedGlobalProperty(
        globalPath: NodePath<t.Node>,
        propertyPath: NodePath<t.Node>,
    ) {
        if (
            isGlobalObjectPath(globalPath) &&
            propertyPath.isStringLiteral()
        ) {
            add(propertyPath.node.value, "r");
        }
    }

    traverse(ast, {
        Identifier(path) {
            if (skipName.has(path.node.name)) {
                return;
            }

            if (path.scope.hasBinding(path.node.name, { noGlobals: true })) {
                return;
            }

            const perm = getGlobalIdentifierPerm(path);

            if (perm == null) {
                return;
            }

            if (!globalAlias.includes(path.node.name)) {
                add(path.node.name, perm);
            }
        },

        MemberExpression(path) {
            let expr = parseMemberExpression(path.node);
            if (expr.length === 0) {
                return;
            }

            if (globalAlias.includes(expr[0]!) || windowAlias.has(expr[0]!)) {
                if (path.scope.hasBinding(expr[0]!, { noGlobals: true })) {
                    return;
                }
            } else if (
                expr.length > 2 &&
                expr[0] === "__webpack_require__" &&
                expr[1] === "g"
            ) {
                expr = expr.slice(2);
            } else {
                return;
            }

            const isWrite =
                (t.isAssignmentExpression(path.parent) &&
                    path.parent.left === path.node) ||
                (t.isUpdateExpression(path.parent) &&
                    path.parent.argument === path.node) ||
                (t.isUnaryExpression(path.parent) &&
                    path.parent.operator === "delete" &&
                    path.parent.argument === path.node);

            // `window.top.frames.fetch` reaches `fetch` on the global object:
            // walk through every alias and record what the chain lands on.
            for (let index = 0; index < expr.length; index += 1) {
                const name = expr[index]!;
                if (globalAlias.includes(name)) {
                    continue;
                }
                if (!skipName.has(name) && !ecmaGlobals.has(name)) {
                    add(
                        name,
                        isWrite && index === expr.length - 1 ? "rw" : "r",
                    );
                }
                if (!windowAlias.has(name)) {
                    break;
                }
            }
        },

        BinaryExpression(path) {
            if (path.node.operator !== "in") {
                return;
            }
            addReflectedGlobalProperty(
                path.get("right") as NodePath<t.Node>,
                path.get("left") as NodePath<t.Node>,
            );
        },

        CallExpression(path) {
            const callee = path.get("callee");
            const args = path.get("arguments");
            if (!callee.isMemberExpression()) {
                return;
            }

            const object = callee.get("object");
            const property = callee.get("property");
            if (
                !object.isIdentifier() ||
                object.scope.hasBinding(object.node.name, {
                    noGlobals: true,
                }) ||
                !property.isIdentifier() ||
                callee.node.computed
            ) {
                return;
            }
            const supported =
                (object.node.name === "Object" &&
                    (property.node.name === "getOwnPropertyDescriptor" ||
                        property.node.name === "hasOwn")) ||
                (object.node.name === "Reflect" &&
                    (property.node.name === "getOwnPropertyDescriptor" ||
                        property.node.name === "has"));
            if (!supported || args.length < 2) {
                return;
            }
            addReflectedGlobalProperty(
                args[0] as NodePath<t.Node>,
                args[1] as NodePath<t.Node>,
            );
        },
    });

    return globals;
}
