export const ScuttleRealGlobal = "__ru1n_qiuwen_myGlobal__";

const scuttleTemplate = () => {
    const getDesc = Object.getOwnPropertyDescriptor;
    const defineProp = Object.defineProperty;
    const getOwnPropNames = Object.getOwnPropertyNames;
    const error = Error;
    const log = (s: string) => {};
    const set = Set;
    const stringify = JSON.stringify;
    const int = parseInt;
    const globalFuncs = [
        "importScripts",
        "alert",
        "atob",
        "blur",
        "btoa",
        "cancelAnimationFrame",
        "cancelIdleCallback",
        "captureEvents",
        "clearInterval",
        "clearTimeout",
        "close",
        "confirm",
        "find",
        "focus",
        "getComputedStyle",
        "getSelection",
        "matchMedia",
        "moveBy",
        "moveTo",
        "open",
        "postMessage",
        "print",
        "prompt",
        "queueMicrotask",
        "releaseEvents",
        "reportError",
        "requestAnimationFrame",
        "requestIdleCallback",
        "resizeBy",
        "resizeTo",
        "setInterval",
        "setTimeout",
        "stop",
        "structuredClone",
        "webkitCancelAnimationFrame",
        "webkitRequestAnimationFrame",
        "fetchLater",
        "webkitRequestFileSystem",
        "webkitResolveLocalFileSystemURL",
        "addEventListener",
        "dispatchEvent",
        "removeEventListener",
        "when",
        "fetch",
        "scroll",
        "scrollBy",
        "scrollTo",
        "getScreenDetails",
        "queryLocalFonts",
        "showDirectoryPicker",
        "showOpenFilePicker",
        "showSaveFilePicker",
    ];
    const myGlobal: any = Object.create(null);
    if (typeof Window !== "undefined") {
        Object.setPrototypeOf(myGlobal, Window.prototype);
    }
    const Reflect = globalThis.Reflect;
    const Proxy = globalThis.Proxy;
    const og = globalThis;

    const props = new set(getOwnPropNames(globalThis));
    for (const k in globalThis) {
        props.add(k);
    }
    const skipProps = [
        "self",
        "window",
        "globalThis",
        ScuttleRealGlobal,
        "__proto__",
    ];
    //@ts-expect-error
    const reserveProps = __PLACEHOLDER_SKIPPROPS__;

    if ((globalThis as any).__ru1n_qiuwen_scuttle_options__ == null) {
        log("No scuttle options found!!!!!");
        throw new error("No scuttle options found");
    }

    const options: Array<{
        file: string;
        line: number;
        col: number;
    }> = (globalThis as any).__ru1n_qiuwen_scuttle_options__;

    for (const prop of props) {
        if (skipProps.includes(prop)) {
            continue;
        }

        // on系列函数是事件响应函数, 需要被正确的绑定到globalThis上
        if (prop.startsWith("on")) {
            defineProp(myGlobal, prop, {
                [prop]: {
                    get() {
                        return (globalThis as any)[prop];
                    },
                    set(value: any) {
                        (globalThis as any)[prop] = value;
                    },
                    enumerable: true,
                    configurable: false,
                },
            });
            continue;
        }

        if (globalFuncs.includes(prop)) {
            const originalFunc = (globalThis as any)[prop];
            myGlobal[prop] = function (...args: any[]) {
                if (this === myGlobal) {
                    return originalFunc.apply(undefined, args);
                } else {
                    return originalFunc.apply(this, args);
                }
            };
        } else {
            myGlobal[prop] = (globalThis as any)[prop];
        }
    }

    defineProp(globalThis, "__ru1n_qiuwen_myGlobal__", {
        get() {
            const stack = new error().stack;
            if (stack == null) {
                log("No call stack available.");
                return null;
            }
            // 2. 按换行符分割成数组
            const stackLines = stack.split("\n");

            // 3. 找到第二层调用信息
            let targetLine = "",
                cc = 0;
            for (let i = 1; i < stackLines.length; i++) {
                const line = stackLines[i]?.trim() ?? "";
                if (line.startsWith("at ")) {
                    if (cc === 1) {
                        targetLine = line;
                        break;
                    }
                    cc++;
                }
            }

            if (!targetLine) {
                log(`No valid call stack information found. ${stack}`);
                return null; // 没有找到有效的调用栈信息
            }

            // 4. 使用正则表达式解析目标行
            // 匹配格式: "at [函数名] (文件名:行号:列号)" 或 "at 文件名:行号:列号"
            const regex1 = /at\s+.+\s+\((.+):(\d+):(\d+)\)/; // 有函数名和括号的情况
            const regex2 = /at\s+(.+):(\d+):(\d+)/; // 没有函数名和括号的情况

            let match = targetLine.match(regex1) || targetLine.match(regex2);

            if (match == null || match.length < 4) {
                log(`Unable to parse call stack line: ${targetLine}`);
                return null;
            }
            const callerInfo = {
                fileName: match[1] ?? "",
                lineNumber: int(match[2] ?? "-1", 10),
                columnNumber: int(match[3] ?? "-1", 10),
                rawLine: targetLine,
            };
            // 校验取值来源是否合法
            for (const option of options) {
                if (
                    callerInfo.fileName.endsWith(option.file) &&
                    callerInfo.lineNumber === option.line &&
                    callerInfo.columnNumber === option.col
                ) {
                    log(
                        `Authorized access to __ru1n_qiuwen_myGlobal__: ${stringify(
                            callerInfo,
                        )}`,
                    );
                    return myGlobal;
                }
            }

            log(
                `Unauthorized access to __ru1n_qiuwen_myGlobal__: ${stringify(
                    callerInfo,
                )}`,
            );

            //@ts-expect-error
            if (__PLACEHOLDER_DEV__) {
                return myGlobal;
            }
            return null;
        },
        set(value) {
            throw new error(
                `Setting global property "__ru1n_qiuwen_myGlobal__" is restricted.`,
            );
        },
        configurable: false,
        enumerable: false,
    });
    myGlobal.window = myGlobal;
    myGlobal.self = myGlobal;
    myGlobal.globalThis = myGlobal;
    myGlobal.__ru1n_qiuwen_oldGlobalThis__ = og;

    for (const prop of props) {
        if (
            skipProps.includes(prop) ||
            prop.startsWith("on") ||
            reserveProps.includes(prop)
        ) {
            continue;
        }

        const desc = getDesc(globalThis, prop);
        if (desc == null) {
            continue;
        }

        if (desc.configurable && desc.get == null && desc.set == null) {
            defineProp(globalThis, prop, {
                get() {
                    log(
                        `Access to global property "${prop}" on globalThis is restricted.`,
                    );
                    //@ts-expect-error
                    if (__PLACEHOLDER_DEV__) {
                        if ((globalThis as any).__ru1nScuttle == null) {
                            (globalThis as any).__ru1nScuttle = [];
                        }
                        if (!(globalThis as any).__ru1nScuttle.includes(prop)) {
                            (globalThis as any).__ru1nScuttle.push(prop);
                        }
                        return myGlobal[prop];
                    } else {
                        throw new error(
                            `Access to global property "${prop}" on globalThis is restricted.`,
                        );
                    }
                },
                set(value) {
                    log(
                        `Setting global property "${prop}" on globalThis is restricted.`,
                    );
                    //@ts-expect-error
                    if (__PLACEHOLDER_DEV__) {
                        if ((globalThis as any).__ru1nScuttle == null) {
                            (globalThis as any).__ru1nScuttle = [];
                        }
                        if (!(globalThis as any).__ru1nScuttle.includes(prop)) {
                            (globalThis as any).__ru1nScuttle.push(prop);
                        }
                        myGlobal[prop] = value;
                    } else {
                        throw new error(
                            `Setting global property "${prop}" on globalThis is restricted.`,
                        );
                    }
                },
                enumerable: true,
                configurable: false,
            });
        } else if (prop === "chrome") {
            (globalThis as any).chrome = new Proxy((globalThis as any).chrome, {
                get(target, p, receiver) {
                    if (p === "storage") {
                        throw new error(
                            `Access to chrome.storage is restricted.`,
                        );
                    }

                    return Reflect.get(target, p, receiver);
                },

                set(target, p, value, receiver) {
                    if (p === "storage") {
                        throw new error(
                            `Access to chrome.storage is restricted.`,
                        );
                    }
                    return Reflect.set(target, p, value, receiver);
                },

                getOwnPropertyDescriptor(target, p) {
                    if (p === "storage") {
                        throw new error(
                            `Access to chrome.storage is restricted.`,
                        );
                    }
                    return Reflect.getOwnPropertyDescriptor(target, p);
                },

                defineProperty(target, property, attributes) {
                    if (property === "storage") {
                        throw new error(
                            `Access to chrome.storage is restricted.`,
                        );
                    }
                    return Reflect.defineProperty(target, property, attributes);
                },

                setPrototypeOf(target, v) {
                    throw new error(
                        `Modifying prototype of chrome is restricted.`,
                    );
                },
            });
        }
    }
};

export function scuttle(reserved: string[]) {}
