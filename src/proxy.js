import fs from "fs";
import path from "path";

const PROXY_FILE = path.resolve("./proxy.txt");
let proxies = [];
let index = 0;

export function loadProxies() {
    if (!fs.existsSync(PROXY_FILE)) {
        console.warn("⚠️ Proxy file not found:", PROXY_FILE);
        proxies = [];
        return;
    }
    const lines = fs.readFileSync(PROXY_FILE, "utf-8")
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);

    proxies = lines.map(line => {
        const [host, port, user, pass] = line.split(":");
        return {host, port, user, pass};
    });
    console.log(`✅ Loaded ${proxies.length} proxies`);
}

export function getNextProxy() {
    if (proxies.length === 0) return null;
    const proxy = proxies[index % proxies.length];
    index++;
    return proxy;
}
