/**
 * Vite `?url` 资源导入声明
 */
declare module '*?url' {
  const src: string;
  export default src;
}

declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
