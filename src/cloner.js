import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());


import fs from "fs-extra";
import path from "path";
import cliProgress from "cli-progress";
import {downloadFile} from "./downloader.js";
import {COLLECT_ONLY, DONE_FILE, MAX_DEPTH, MAX_PAGES, OUTPUT_DIR, saveProgress} from "./utils.js";
import {getNextProxy, loadProxies} from "./proxy.js";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
// const OUTPUT_DIR = "./crawl-data";
const VISITED_FILE = path.join(OUTPUT_DIR, "visited.json");
const TREE_FILE = path.join(OUTPUT_DIR, "results.json");

function loadJson(file, fallback) {
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    return fallback;
}

function saveJson(file, data) {
    if (data === undefined || data === null) {
        console.warn(`⚠️ Skip saving ${file} because data is null/undefined`);
        return;
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// tìm node trong cây theo url
function findNode(root, url) {
    if (root.url === url) return root;
    if (!root.children) return null;
    for (const child of root.children) {
        const found = findNode(child, url);
        if (found) return found;
    }
    return null;
}

function normalizeUrl(url) {
    try {
        const u = new URL(url);
        u.hash = ""; // bỏ fragment (#...)
        u.search = ""; // có thể bỏ query nếu không muốn coi ?x=y là URL mới

        // Chuẩn hóa root path: https://znews.vn/ -> https://znews.vn
        if (u.pathname === "/" || u.pathname === "") {
            u.pathname = "";
        }

        return u.toString();
    } catch {
        return url;
    }
}
// loadProxies();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min = 2000, max = 5000) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sanitizeFilename(url) {
    return url.replace(/[^a-z0-9]/gi, "_").slice(0, 100);
}


async function launchBrowserWithProxy() {
    const proxy = getNextProxy();
    const args = [];
    if (proxy) {
        args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
    }

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-http2", // 👈 ép dùng HTTP/1.1
            // "--disable-setuid-sandbox",
            // "--disable-dev-shm-usage",
            // "--disable-blink-features=AutomationControlled",
            // "--disable-features=site-per-process",
            // "--no-zygote",
            // "--single-process",
            // "--disable-features=NetworkService",
            ...args
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    });

    if (proxy?.user && proxy?.pass) {
        browser.on("targetcreated", async target => {
            try {
                const page = await target.page();
                if (page) {
                    await page.authenticate({
                        username: proxy.user,
                        password: proxy.pass
                    });
                }
                await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");
                await page.setExtraHTTPHeaders({
                    "Accept-Language": "en-US,en;q=0.9",
                    "Upgrade-Insecure-Requests": "1"
                });
            } catch {
            }
        });
    }
    return browser;
}

async function safeGoto(page, url, timeoutMs = 15000) {
    try {
        await page.goto(url, {
            waitUntil: ["domcontentloaded", "networkidle2"],
            timeout: 60000, // tăng lên 60s
        });
    } catch (err) {
        console.warn(`⚠️ Goto failed for ${url}: ${err.message}`);
        return [];
    }
}

async function extractLinks(browser, url, baseDomain) {
    const page = await browser.newPage();
    try {
        const ok = await safeGoto(page, url, 15000); // timeout 15s
        if (!ok) return [];

        const links = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a"))
                .map(a => a.href)
                .filter(href => href)
        );

        return links;
    } catch (err) {
        console.error(`❌ extractLinks failed for ${url}:`, err.message);
        return [];
    } finally {
        await page.close();
    }
}


async function processPage(targetUrl) {
    const browser = await launchBrowserWithProxy();
    const page = await browser.newPage();

    try {
        await page.goto(targetUrl, {waitUntil: "networkidle2", timeout: 60000});
    } catch (err) {
        console.error("Page failed:", targetUrl, err.message);
        await browser.close();
        return false;
    }

    let modifiedHtml = await page.content();

    const resources = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll("link[href]").forEach(el => urls.push(el.href));
        document.querySelectorAll("script[src]").forEach(el => urls.push(el.src));
        document.querySelectorAll("img[src]").forEach(el => urls.push(el.src));
        document.querySelectorAll("source[src], source[srcset]").forEach(el => {
            if (el.src) urls.push(el.src);
            if (el.srcset) urls.push(el.srcset);
        });
        return urls;
    });

    for (const url of resources) {
        try {
            const urlObj = new URL(url);
            if (url.match(/\.(css|js|png|jpe?g|gif|svg|ico|woff2?|ttf)$/i)) {
                const filePath = path.join(OUTPUT_DIR, urlObj.hostname, urlObj.pathname);
                await downloadFile(url, filePath);
                modifiedHtml = modifiedHtml.replaceAll(url, path.relative(OUTPUT_DIR, filePath));
            }
        } catch {
            console.error("Skip:", url);
        }
    }

    const urlObj = new URL(targetUrl);
    let savePath = path.join(OUTPUT_DIR, urlObj.hostname, urlObj.pathname);
    if (savePath.endsWith("/")) savePath = path.join(savePath, "index.html");
    else if (!path.extname(savePath)) savePath += ".html";

    await fs.ensureDir(path.dirname(savePath));
    await fs.writeFile(savePath, modifiedHtml);

    await browser.close();
    return true;
}

async function collectUrls(startUrl, maxDepth = 3) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // load dữ liệu cũ
    let visited = new Set(loadJson(VISITED_FILE, []));
    let tree = loadJson(TREE_FILE, null);

    const rootUrl = normalizeUrl(startUrl);
    if (!tree) {
        tree = { url: rootUrl, depth: 0, children: [] };
    }

    const baseDomain = new URL(rootUrl).hostname;
    const browser = await launchBrowserWithProxy();

    const queue = [{ url: rootUrl, depth: 0 }];

    while (queue.length > 0) {
        const { url, depth } = queue.shift();
        const normalizedUrl = normalizeUrl(url);

        if (visited.has(normalizedUrl)) continue;
        if (depth > maxDepth) continue;

        console.log(`🌐 Crawling [${depth}] ${normalizedUrl}`);

        let links = await extractLinks(browser, normalizedUrl, baseDomain);

        // lọc bỏ file media/js/css
        links = links
            .map(normalizeUrl)
            .filter(l => {
                try {
                    const u = new URL(l);
                    if (u.hostname !== baseDomain) return false;
                    return !/\.(jpg|jpeg|png|gif|svg|ico|css|js|woff2?|ttf|mp4|webm)$/i.test(u.pathname);
                } catch {
                    return false;
                }
            });

        // tạo node trong cây
        const parentNode = findNode(tree, normalizedUrl);
        if (parentNode) {
            parentNode.children = parentNode.children || [];
            for (const link of links) {
                const normalizedLink = normalizeUrl(link);
                if (!visited.has(normalizedLink) &&
                    !parentNode.children.some(c => c.url === normalizedLink)) {
                    parentNode.children.push({
                        url: normalizedLink,
                        depth: depth + 1,
                        children: []
                    });
                    queue.push({ url: normalizedLink, depth: depth + 1 });
                }
            }
        }

        // đánh dấu visited và lưu ra file
        visited.add(normalizedUrl);
        saveJson(VISITED_FILE, [...visited]);
        saveJson(TREE_FILE, tree);

        console.log(`✅ Saved node: ${normalizedUrl} (${links.length} children)`);
    }

    await browser.close();
    console.log("🎉 Done crawling!");
}


export async function cloneSite(startUrl) {
    const tree = await collectUrls(startUrl, MAX_DEPTH);
    console.log("✅ Crawl tree built");

    const treeFile = path.join(OUTPUT_DIR, "tree.json");
    await fs.ensureDir(OUTPUT_DIR);
    await fs.writeJson(treeFile, tree, { spaces: 2 });
    console.log("Saved crawl tree to", treeFile);

    if (COLLECT_ONLY) {
        console.log("Collect-only mode enabled. Exiting after saving tree.");
        return;
    }

    // Đọc danh sách đã hoàn thành từ DONE_FILE
    let done = new Set();
    if (await fs.pathExists(DONE_FILE)) {
        const doneList = await fs.readFile(DONE_FILE, "utf-8");
        done = new Set(doneList.split("\n").filter(Boolean));
    }

    // Tính tổng số node trong tree
    const countNodes = (node) =>
        1 + (node.children ? node.children.reduce((sum, c) => sum + countNodes(c), 0) : 0);
    const totalNodes = countNodes(tree);

    const browser = await launchBrowserWithProxy();
    const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    bar.start(totalNodes, done.size);

    // DFS clone
    async function dfsClone(node) {
        const url = node.url;

        if (!done.has(url)) {
            let success = false;

            for (let attempt = 1; attempt <= 3; attempt++) {
                success = await processPage(browser, url);
                if (success) break;
                console.warn(`Retry ${attempt}/3 failed for ${url}`);
            }

            if (success) {
                done.add(url);
                await saveProgress(done);
            } else {
                console.error(`❌ Skip after 3 retries: ${url}`);
            }

            bar.update(done.size);

            const delay = randomDelay(2000, 5000);
            console.log(`⏳ Delay ${delay}ms trước khi clone tiếp...`);
            await sleep(delay);
        }

        if (node.children && node.children.length > 0) {
            for (const child of node.children) {
                await dfsClone(child);
            }
        }
    }

    await dfsClone(tree);

    bar.stop();
    await browser.close();
    console.log("Clone finished! Total pages cloned:", done.size);
}