import * as t from "@babel/types";
import traverse, { NodePath } from "@babel/traverse";
import { globalFuncs, windowAliases } from "./capabilities";

export function rewriteGlobalFunctionBind(ast: t.File): boolean {
    const globalAlias = ["globalThis", "self", "window", ...windowAliases];
    let changed = false;

    function isStaticProperty(
        node: t.MemberExpression,
        name: string,
    ): boolean {
        if (!node.computed) {
            return t.isIdentifier(node.property, { name });
        }

        return t.isStringLiteral(node.property, { value: name });
    }

    function getStaticPropertyName(node: t.MemberExpression) {
        if (!node.computed && t.isIdentifier(node.property)) {
            return node.property.name;
        }

        if (t.isStringLiteral(node.property)) {
            return node.property.value;
        }

        return null;
    }

    function getGlobalFunctionName(
        path: NodePath<t.Expression | t.Super>,
    ): string | null {
        if (path.isIdentifier()) {
            if (path.scope.hasBinding(path.node.name, { noGlobals: true })) {
                return null;
            }
            return globalFuncs.includes(path.node.name) ? path.node.name : null;
        }

        if (!path.isMemberExpression()) {
            return null;
        }

        const object = path.get("object");
        if (!object.isIdentifier()) {
            return null;
        }

        if (!globalAlias.includes(object.node.name)) {
            return null;
        }

        if (path.scope.hasBinding(object.node.name, { noGlobals: true })) {
            return null;
        }

        const name = getStaticPropertyName(path.node);
        return name != null && globalFuncs.includes(name) ? name : null;
    }

    function isSandboxGlobalAlias(path: NodePath<t.Node>) {
        if (!path.isIdentifier()) {
            return false;
        }

        return (
            globalAlias.includes(path.node.name) &&
            !path.scope.hasBinding(path.node.name, { noGlobals: true })
        );
    }

    traverse(ast, {
        CallExpression(path) {
            if (!t.isMemberExpression(path.node.callee)) {
                return;
            }

            if (!isStaticProperty(path.node.callee, "bind")) {
                return;
            }

            const target = path.get("callee.object");
            if (getGlobalFunctionName(target) == null) {
                return;
            }

            const firstArg = path.get("arguments.0");
            if (!firstArg.node || !isSandboxGlobalAlias(firstArg)) {
                return;
            }

            firstArg.replaceWith(t.identifier("undefined"));
            changed = true;
        },
    });

    return changed;
}
