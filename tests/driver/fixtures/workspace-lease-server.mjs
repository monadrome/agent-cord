// 独立 server 进程，用于验证 SQLite lease 的真实 HTTP 跨进程边界。
const { buildApp } = await import(new URL("../../../apps/server/src/app.ts", import.meta.url));
const server = await buildApp({ root: process.argv[2] });
await server.app.listen({ port: 0, host: "127.0.0.1" });
process.send?.({ base: "http://127.0.0.1:" + server.app.server.address().port });
process.on("message", async message => {
  if (message?.action === "close") {
    await server.app.close(); server.index.close(); process.exit(0);
  }
});
