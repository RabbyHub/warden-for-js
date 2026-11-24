export type { GlobalAccessMode } from "./global/types";
export { analyzeGlobalAccess } from "./global/analysis";
export { rewriteGlobalFunctionBind } from "./global/bind-rewrite";
export {
    getMkCompartmentSource,
    mkCompartment,
    mkCompartmentFactory,
} from "./global/sandbox";
