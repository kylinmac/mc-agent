import { createServer } from "node:http";

const users = new Map([["demo", "demo"]]);

createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/login") {
        response.writeHead(404).end();
        return;
    }
    let body = "";
    request.on("data", (chunk) => {
        body += chunk;
    });
    request.on("end", () => {
        const { username, password } = JSON.parse(body || "{}");
        const ok = users.get(username) === password;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(ok ? { ok, username } : { ok, error: "invalid credentials" }));
    });
}).listen(3000);
