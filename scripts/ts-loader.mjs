/**
 * Node ESM 解析钩子：让无扩展名的内部相对导入解析到 .ts 文件，
 * 配合 --experimental-strip-types 直接运行 TypeScript 源码。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
    const parentPath = fileURLToPath(context.parentURL);
    const base = new URL(specifier, context.parentURL);
    const candidate = fileURLToPath(base) + '.ts';
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    void parentPath;
  }
  return nextResolve(specifier, context);
}
