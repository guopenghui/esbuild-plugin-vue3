import { transform } from "@babel/core";
import vue3Jsx from "@vue/babel-plugin-jsx";

import type { TransformOptions, PluginOptions } from "@babel/core";
// @ts-ignore
import TS from "@babel/plugin-syntax-typescript";

async function transformVue3(code: string, id: string, options: Record<string, any>) {
    const transformOptions: TransformOptions = {
        babelrc: false,
        configFile: false,
        plugins: [[vue3Jsx, options]],
        sourceMaps: !!(options.sourceMap),
        sourceFileName: id,
    };
    // if (/\.tsx?$/.test(id)) {
    transformOptions.plugins!.push([TS, { isTSX: true }]);
    // }

    const result = transform(code, transformOptions);
    if (!result?.code) return;

    return {
        code: result.code,
        map: result.map,
    };
}

export { transformVue3 };