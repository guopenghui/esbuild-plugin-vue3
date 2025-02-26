import * as esbuild from "esbuild";
import * as path from "path";
import * as fs from 'fs';
import * as crypto from "crypto";

import * as sfc from '@vue/compiler-sfc';
import * as core from '@vue/compiler-core';


import { loadRules, replaceRules } from "./paths";
import { AsyncCache, fileExists, getFullPath, getUrlParams, tryAsync } from "./utils";
import { Options } from "./options";
import { generateIndexHTML } from "./html";
import randomBytes from "./random";
import { transformVue3 } from "./compilers";

type PluginData = {
    descriptor: sfc.SFCDescriptor;
    id: string;
    script?: sfc.SFCScriptBlock;
};

const vuePlugin = (opts: Options = {}) => <esbuild.Plugin>{
    name: "vue",
    async setup({ initialOptions: buildOpts, ...build }) {
        buildOpts.define = {
            ...buildOpts.define,
            "__VUE_OPTIONS_API__": opts.disableOptionsApi ? "false" : "true",
            "__VUE_PROD_DEVTOOLS__": opts.enableDevTools ? "true" : "false",
            "process.env.NODE_ENV": process.env.NODE_ENV === 'production' || opts.isProd ? "'production'" : "'development'"
        };

        if (opts.generateHTML && !buildOpts.metafile) {
            buildOpts.metafile = true;
        }

        if (opts.disableResolving) {
            opts.pathAliases = false;
            build.onStart(() => ({ warnings: [{ text: "The disableResolving option is deprecated, use pathAliases instead" }] }));
        }

        const mustReplace = await loadRules(opts, buildOpts.tsconfig ?? "tsconfig.json");

        const random = randomBytes(typeof opts.scopeId === "object" && typeof opts.scopeId.random === "string" ? opts.scopeId.random : undefined);

        const cache = new AsyncCache(!opts.disableCache);

        const transforms: Record<string, core.DirectiveTransform> = {};
        if (opts.directiveTransforms) {
            for (const name in opts.directiveTransforms) {
                if (Object.prototype.hasOwnProperty.call(opts.directiveTransforms, name)) {
                    const propName = opts.directiveTransforms[name];

                    const transformation = (dir: core.DirectiveNode, name: string) => <core.Property>{
                        key: core.createSimpleExpression(JSON.stringify(name), false),
                        value: dir.exp ?? core.createSimpleExpression("void 0", false),
                        loc: dir.loc,
                        type: 16
                    };

                    if (typeof propName === "function") {
                        transforms[name] = (...args) => {
                            const ret = propName(args[0], args[1], args[2]);

                            return {
                                props: ret === undefined ? [] : [transformation(args[0], ret)]
                            };
                        };
                    } else {
                        transforms[name] = dir => ({
                            props: propName === false ? [] : [transformation(dir, propName)]
                        });
                    }
                }
            }
        }

        if (mustReplace) {
            build.onResolve({ filter: /.*/ }, async args => {
                const aliased = replaceRules(args.path);
                const fullPath = path.isAbsolute(aliased) ? aliased : path.join(process.cwd(), aliased);

                if (!await fileExists(fullPath)) {
                    const possible = [
                        ".ts",
                        ".tsx",
                        "/index.ts",
                        "/index.tsx",
                        ".js",
                        ".jsx",
                        "/index.js",
                        "/index.jsx",
                    ];

                    for (const postfix of possible) {
                        if (await fileExists(fullPath + postfix)) {
                            return {
                                path: path.normalize(fullPath + postfix),
                                namespace: "file"
                            };
                        }
                    }
                } else {
                    return {
                        path: path.normalize(fullPath),
                        namespace: "file"
                    };
                }
            });
        }

        // Resolve main ".vue" import
        build.onResolve({ filter: /\.vue/ }, async (args) => {
            const params = getUrlParams(args.path);

            return {
                path: getFullPath(args),
                namespace:
                    params.type === "script" ? "sfc-script" :
                        params.type === "template" ? "sfc-template" :
                            params.type === "style" ? "sfc-style" : "file",
                pluginData: {
                    ...args.pluginData,
                    index: params.index
                }
            };
        });

        // Load .tsx/.jsx file
        build.onLoad({ filter: /\.[tj]sx$/ }, (args) => cache.get([args.path, args.namespace], async () => {
            const source = await fs.promises.readFile(args.path, "utf-8");
            let res = await transformVue3(source, "", {});
            if (!res?.code) {
                return;
            }
            return {
                contents: res.code,
                resolveDir: path.dirname(args.path),
                watchFiles: [args.path]
            };
        }));

        // Load stub when .vue is requested
        build.onLoad({ filter: /\.vue$/ }, (args) => cache.get([args.path, args.namespace], async () => {
            const encPath = args.path.replace(/\\/g, "\\\\");

            const source = await fs.promises.readFile(args.path, 'utf8');
            const filename = path.relative(process.cwd(), args.path);

            const id = !opts.scopeId || opts.scopeId === "hash"
                ? crypto.createHash("md5").update(filename).digest().toString("hex").substring(0, 8)
                : random(4).toString("hex");

            const { descriptor } = sfc.parse(source, {
                filename
            });
            const script = (descriptor.script || descriptor.scriptSetup) ? sfc.compileScript(descriptor, { id }) : undefined;

            const dataId = "data-v-" + id;
            let code = "";

            if (descriptor.script || descriptor.scriptSetup) {
                code += `import script from "${encPath}?type=script";`;
            } else {
                code += "const script = {};";
            }

            for (const style in descriptor.styles) {
                code += `import "${encPath}?type=style&index=${style}";`;
            }

            const renderFuncName = opts.renderSSR ? "ssrRender" : "render";

            code += `import { ${renderFuncName} } from "${encPath}?type=template"; script.${renderFuncName} = ${renderFuncName};`;

            code += `script.__file = ${JSON.stringify(filename)};`;
            if (descriptor.styles.some(o => o.scoped)) {
                code += `script.__scopeId = ${JSON.stringify(dataId)};`;
            }
            if (opts.renderSSR) {
                code += "script.__ssrInlineRender = true;";
            }

            code += "export default script;";

            return {
                contents: code,
                resolveDir: path.dirname(args.path),
                pluginData: { descriptor, id: dataId, script } as PluginData,
                watchFiles: [args.path]
            };
        }));

        build.onLoad({ filter: /.*/, namespace: "sfc-script" }, (args) => cache.get([args.path, args.namespace], async () => {
            const { script } = args.pluginData as PluginData;

            if (script) {
                let code = script.content;

                if (!script.lang || !["ts", "tsx", "js", "jsx"].includes(script.lang)) {
                    throw new Error(`Fail to resolve script type in ${args.path}`);
                }

                if (buildOpts.sourcemap && script.map) {
                    const sourceMap = Buffer.from(JSON.stringify(script.map)).toString("base64");

                    code += "\n\n//@ sourceMappingURL=data:application/json;charset=utf-8;base64," + sourceMap;
                }

                if (script.lang?.match(/[tj]sx/)) {
                    let res = await transformVue3(code, "", {});
                    if (!res) {
                        throw new Error(`Fail to transform vue script to ${script.lang} in ${args.path}`);
                    }
                    code = res.code;
                }

                return {
                    contents: code,
                    loader: ["ts", "tsx"].includes(script.lang) ? "ts" : "js",
                    resolveDir: path.dirname(args.path),
                };
            }
        }));

        build.onLoad({ filter: /.*/, namespace: "sfc-template" }, (args) => cache.get([args.path, args.namespace], async () => {
            const { descriptor, id, script } = args.pluginData as PluginData;
            if (!descriptor.template) {
                throw new Error("Missing template");
            }

            let source = descriptor.template.content;

            if (descriptor.template.lang === "pug") {
                const pug = await tryAsync(() => import("pug"), "pug", "Pug template rendering");
                source = pug.render(descriptor.template.content);

                // Fix #default="#default" and v-else="v-else"
                source = source.replace(/(\B#.*?|\bv-.*?)="\1"/g, "$1");
            }

            const result = sfc.compileTemplate({
                id,
                source,
                filename: args.path,
                scoped: descriptor.styles.some(o => o.scoped),
                slotted: descriptor.slotted,
                ssr: opts.renderSSR,
                ssrCssVars: [],
                isProd: (process.env.NODE_ENV === "production") || buildOpts.minify,
                compilerOptions: {
                    inSSR: opts.renderSSR,
                    directiveTransforms: transforms,
                    bindingMetadata: script?.bindings
                }
            });

            if (result.errors.length > 0) {
                return {
                    errors: result.errors.map<esbuild.PartialMessage>(o => typeof o === "string" ? { text: o } : {
                        text: o.message,
                        location: o.loc && {
                            column: o.loc.start.column,
                            file: descriptor.filename,
                            line: o.loc.start.line + descriptor.template!.loc.start.line + 1,
                            lineText: o.loc.source
                        }
                    })
                };
            }

            return {
                contents: result.code,
                warnings: result.tips.map(o => ({ text: o })),
                loader: "js",
                resolveDir: path.dirname(args.path),
            };
        }));

        build.onLoad({ filter: /.*/, namespace: "sfc-style" }, (args) => cache.get([args.path, args.namespace], async () => {
            const { descriptor, index, id } = args.pluginData as PluginData & { index: number; };

            const style: import("@vue/compiler-sfc").SFCStyleBlock = descriptor.styles[index];
            let includedFiles: string[] = [];

            const result = await sfc.compileStyleAsync({
                filename: args.path,
                id,
                source: style.content,
                postcssOptions: opts.postcss?.options,
                postcssPlugins: opts.postcss?.plugins,
                preprocessLang: style.lang as any,
                preprocessOptions: {
                    includePaths: [
                        path.dirname(args.path)
                    ],
                    importer: [
                        (url: string) => {
                            const modulePath = path.join(process.cwd(), "node_modules", url);

                            if (fs.existsSync(modulePath)) {
                                return { file: modulePath };
                            }

                            return null;
                        },
                        (url: string) => ({ file: replaceRules(url) })
                    ]
                },
                scoped: style.scoped,
            });

            if (result.errors.length > 0) {
                const errors = result.errors as (Error & { column: number; line: number; file: string; })[];

                return {
                    errors: errors.map(o => ({
                        text: o.message,
                        location: {
                            column: o.column,
                            line: o.file === args.path ? style.loc.start.line + o.line - 1 : o.line,
                            file: o.file.replace(/\?.*?$/, ""),
                            namespace: "file"
                        }
                    }))
                };
            }

            return {
                contents: result.code,
                loader: "css",
                resolveDir: path.dirname(args.path),
                watchFiles: includedFiles
            };
        }));

        build.onEnd(async result => {
            if (opts?.generateHTML && result.errors.length == 0) {
                if (typeof opts.generateHTML === "string") {
                    opts.generateHTML = {
                        sourceFile: opts.generateHTML
                    };
                }

                const outDir = buildOpts.outdir
                    ? buildOpts.outdir
                    : buildOpts.outfile
                        ? path.dirname(buildOpts.outfile)
                        : undefined;

                opts.generateHTML.trimPath ??= outDir;
                opts.generateHTML.pathPrefix ??= "/";
                opts.generateHTML.outFile ??= outDir && path.join(outDir, "index.html");

                await generateIndexHTML(result, opts.generateHTML, buildOpts.minify ?? false);
            }
        });
    }
};

export = vuePlugin;